// ── the seam over a port ────────────────────────────────────────────────────
//
// A spawner from the port layer hands up a raw channel: octets for a stdio pair, parts for a medium that
// frames its own lines.  The seam's frames sit four steps above that — split, decode, agree, and the reader
// shape — and this file is those steps in one place, so a spawner says only what medium it is.
//
// The last step belongs to the seam: `Channel<F>` gives each reader its own unsubscribe and tells a close
// why; `FrameChannel` returns the unsubscribe from `onMessage` and says nothing on `onClose`.  Both ends of
// that difference are published, so it is bridged here rather than changed on either side.
//
// `Channel` also has an error of its own, and `FrameChannel` has none: a wire that fails is heard here as the
// close that always follows it, which is what the seam has always heard.

import type { Announcement, Channel, Delivered, Part } from "../port/index.js";
import { handshake, json1, readFrame, splitChannel } from "../port/index.js";
import type { StringTransport } from "./channel.js";
import type { FrameChannel } from "../types.js";
import type { ClientSpawner } from "./client.js";
import { announcedOctets, VERSION } from "./protocols/json1.js";

/** How many octets follow this line on the seam: a `$chunk` head says, and nothing else does. */
export function seamAnnounced(line: string): number | null {
  return announcedOctets(readFrame(line));
}

/** What a connection may set on its way up. */
export interface JsonSeamOptions {
  /** How long to wait for the peer to say what it speaks. */
  timeoutMs?: number;
  /** Settles when the medium can carry a frame: nothing is announced before it. */
  ready?: Promise<void>;
}

/**
 * A port's channel, read as the seam's frames.
 *
 * A frame and the octets it announced are one value above the protocol and two facts below it; this is where
 * they separate again, because `FrameChannel` keeps them on two subscriptions.  One reader on the opened
 * channel does that separating: a subscription per kind would each be handed a share of what the handshake
 * held, and whichever filter did not want it would throw it away.
 *
 * A value nobody is reading yet is kept, one list per kind.  What arrived before there was anybody to take it
 * goes to every reader that comes for it, not to the first alone: a connection's readers do not all subscribe
 * at the same instant — the store that follows a chunk is built before the serve that waits for `$init` — and a
 * frame that crossed the wire before either existed belongs to neither of them in particular.  The lists end
 * when a frame is delivered to a reader: from then on the connection is being served, and a reader that comes
 * later has missed what went before it, the way it would on any live wire.
 */
export function frameChannel(opened: Channel<Delivered>): FrameChannel {
  const frameReaders = new Set<(frame: Record<string, unknown>) => void>();
  const segmentReaders = new Set<(frame: Record<string, unknown>, bytes: Uint8Array) => void>();
  const closers = new Set<() => void>();
  const heldFrames: Record<string, unknown>[] = [];
  const heldSegments: Array<[Record<string, unknown>, Uint8Array]> = [];
  let ended = false;
  let subscribed = false;

  const deliver = (value: Delivered): void => {
    if (value.bytes === null) {
      // Nobody is reading yet: the frame waits for whoever comes.  Once somebody is, the connection is being
      // served, and what predates every reader is finished — a reader arriving after this missed it by
      // construction, which is what a live connection means.
      if (frameReaders.size === 0) {
        heldFrames.push(value.frame);
        return;
      }
      heldFrames.length = 0;
      for (const reader of [...frameReaders]) reader(value.frame);
      return;
    }
    if (segmentReaders.size === 0) {
      heldSegments.push([value.frame, value.bytes]);
      return;
    }
    heldSegments.length = 0;
    for (const reader of [...segmentReaders]) reader(value.frame, value.bytes);
  };

  const subscribe = (): void => {
    if (subscribed) return;
    subscribed = true;
    opened.onFrame(deliver);
    opened.onClose(() => {
      ended = true;
      for (const closer of [...closers]) closer();
    });
  };

  return {
    send: (frame) => opened.send({ frame, bytes: null }),
    onMessage(handler) {
      // Subscribed before the reader is listed, so what the handshake hands over on the way in is held for
      // every reader rather than served to whichever of them happened to be first.
      subscribe();
      frameReaders.add(handler);
      for (const frame of heldFrames) handler(frame);
      return () => {
        frameReaders.delete(handler);
      };
    },
    sendSegment: (frame, bytes) => opened.send({ frame, bytes }),
    onSegment(handler) {
      subscribe();
      segmentReaders.add(handler);
      for (const [frame, bytes] of heldSegments) handler(frame, bytes);
      return () => {
        segmentReaders.delete(handler);
      };
    },
    onClose(handler) {
      if (ended) {
        handler();
        return;
      }
      closers.add(handler);
      subscribe();
    },
    close: () => opened.close(),
  };
}

async function overParts(parts: Channel<Part>, options: JsonSeamOptions): Promise<FrameChannel> {
  const agreed = await handshake(json1(parts), {
    version: VERSION,
    timeoutMs: options.timeoutMs,
    ready: options.ready,
  });
  return frameChannel(agreed);
}

/**
 * The spawner says only how to open its medium.  Splitting, decoding and agreeing are the same work for all
 * of them, and a caller that wired them itself would be wiring three adapters where the medium was the only
 * thing that differed.
 */
export function jsonSeam<Args = unknown>(
  spawner: (args: Args) => Promise<Channel<Uint8Array>>,
  options: JsonSeamOptions = {},
): ClientSpawner<Args> {
  return async (args) => overParts(splitChannel(await spawner(args), seamAnnounced), options);
}

/** A spawner that already hands up parts: a medium that frames its own lines and splits nothing. */
export function jsonSeamParts<Args = unknown>(
  spawner: (args: Args) => Promise<Channel<Part>>,
  options: JsonSeamOptions = {},
): ClientSpawner<Args> {
  return async (args) => overParts(await spawner(args), options);
}

/**
 * A line transport, as the port a seam composes over.
 *
 * A medium that frames its own messages — a websocket message, a line on a socket — hands up lines, and a
 * line that announces octets is one part in two halves: this side answers with how many octets follow, and
 * the transport then hands those over as bytes.  A part is that line and those octets, so they are held here
 * for the moment between the two.
 *
 * This is the adapter that lets the listeners keep their transports while the seam above them is a port:
 * `handshake(json1(partsOf(transport)))` is the whole of what a serving half does with a transport now.
 */
export function partsOf(transport: StringTransport, announced: Announcement = seamAnnounced): Channel<Part> {
  const readers = new Set<(part: Part) => void>();
  const closers = new Set<(reason: string) => void>();
  /** The line whose announced octets have not arrived yet. */
  let held: string | null = null;
  let ended = false;

  const emit = (part: Part): void => {
    for (const reader of [...readers]) reader(part);
  };

  transport.onMessage((line) => {
    if (ended) return;
    const count = announced(line);
    if (count === null) {
      emit({ line, bytes: null });
      return;
    }
    held = line;
    return count;
  });
  transport.onBytes((bytes) => {
    const line = held;
    held = null;
    // Octets nobody announced are a peer talking past the protocol: the splitter above says so, so they are
    // dropped here rather than attached to whatever line came last.
    if (line === null) return;
    emit({ line, bytes });
  });
  transport.onClose(() => {
    if (ended) return;
    ended = true;
    for (const closer of [...closers]) closer("the far end closed the connection");
  });

  return {
    async send(part) {
      await transport.send(part.line);
      if (part.bytes !== null) await transport.sendBytes(part.bytes);
    },
    onFrame(handler) {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    onClose(handler) {
      closers.add(handler);
      return () => {
        closers.delete(handler);
      };
    },
    onError() {
      // A line transport reports a broken wire as the close that follows it.
      return () => {};
    },
    close: () => transport.close(),
  };
}

/**
 * A connection a medium has already framed, as the seam's frames: the counterpart of `jsonSeam` for a
 * transport rather than a port.
 *
 * A line transport hands up lines, which `partsOf` turns into the port's parts; the splitter, the encoding and
 * the agreement are then the same work a raw medium's channel would have gone through.  Both ends announce, so
 * a serving half and its client reach the protocol the same way round.
 */
export async function seamOf(
  transport: StringTransport,
  options: JsonSeamOptions = {},
): Promise<FrameChannel> {
  // The reader chain is installed here, synchronously, before anything is awaited: a medium that delivers a
  // frame in the same turn this is called — a socket can — must not find nobody listening.
  const delivered = json1(partsOf(transport));
  return frameChannel(
    await handshake(delivered, {
      version: VERSION,
      timeoutMs: options.timeoutMs,
      ready: options.ready,
    }),
  );
}
