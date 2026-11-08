// ── the seam over a port ────────────────────────────────────────────────────
//
// Composes a medium's channel into the seam's frames: split bytes into lines, decode `json.v1`, agree on the
// protocol, and bridge the result onto `FrameChannel`.  A spawner supplies the channel underneath: bytes, or parts
// where its medium already frames its own lines.
//
// The bridge is here because the two channel types differ.  `Channel<F>` returns an unsubscribe from every
// subscription, gives a reason on close, and has an error of its own; `FrameChannel` returns one from
// `onMessage` only, says nothing on `onClose`, and has no error, so a failed wire reaches its reader as the
// close that follows it.

import type { Announcement, Channel, Part } from "../port/index.js";
import { splitChannel } from "../port/index.js";
import type { StringTransport } from "./channel.js";
import { handshake } from "./handshake.js";
import type { ClientSpawner } from "./client.js";
import { announcedOctets, json1, readFrame, VERSION, type Delivered } from "./protocols/json1.js";
import type { FrameChannel } from "../types.js";

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
 * `Channel<Delivered>` carries a frame and the octets it announced as one value; `FrameChannel` reports them on
 * two subscriptions, so this function splits them.  It is one reader on the opened channel rather than one per
 * kind: the handshake gives a held value to the first subscriber, and a subscription per kind would drop
 * whichever half that subscriber did not want.
 *
 * A frame that arrives while nobody is subscribed is kept, one list per kind.  Every reader that subscribes
 * before the first frame is delivered gets those, not just the first to ask; after that a reader gets only what
 * arrives while it is subscribed.  The readers are not installed at the same moment — the stream store is
 * built before the serve that waits for `$init` — which is why the lists exist at all.
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
      // No reader yet, so the frame is held.  Held frames are given to every reader that subscribes before the
      // first frame is delivered; after that a reader gets only what arrives while it is subscribed.
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

/** Parts to the seam's frames: decode, agree, and bridge. */
async function overParts(parts: Channel<Part>, options: JsonSeamOptions): Promise<FrameChannel> {
  const agreed = await handshake(json1(parts), {
    version: VERSION,
    timeoutMs: options.timeoutMs,
    ready: options.ready,
  });
  return frameChannel(agreed);
}

/**
 * A spawner whose channel carries bytes, as one that hands back the seam's frames.
 *
 * It inserts `splitChannel`, then decodes, agrees and bridges.  Nothing above the medium depends on which
 * medium it is, so a spawner says how to open one and this does the rest.
 */
export function jsonSeam<Args = unknown>(
  spawner: (args: Args) => Promise<Channel<Uint8Array>>,
  options: JsonSeamOptions = {},
): ClientSpawner<Args> {
  return async (args) => overParts(splitChannel(await spawner(args), seamAnnounced), options);
}

/** The same for a spawner whose medium already frames whole lines, where no splitter is inserted. */
export function jsonSeamParts<Args = unknown>(
  spawner: (args: Args) => Promise<Channel<Part>>,
  options: JsonSeamOptions = {},
): ClientSpawner<Args> {
  return async (args) => overParts(await spawner(args), options);
}

/**
 * A line transport as the port the seam composes over.
 *
 * A medium that frames its own messages — a websocket message, a line on a socket — hands up lines.  A line that
 * announces octets arrives in two calls: this side answers with how many octets follow and the transport hands
 * them over as bytes.  A part is the line and those octets, so the line is held until its octets arrive.
 *
 * It is what lets a listener keep its transport while the seam above it is a port:
 * `handshake(json1(partsOf(transport)))`.
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
    info: {},
    control: () => {},
  };
}

/**
 * A transport as the seam's frames: the transport counterpart of `jsonSeam`.
 *
 * `partsOf` turns the lines into parts, then the encoding and the agreement run as they do for any port.  The
 * readers are installed synchronously, before this function awaits anything, because a medium can deliver a
 * frame in the same turn it is handed over.
 *
 * `ready` holds the `$proto` announcement until the medium can carry it; see `JsonSeamOptions`.
 */
export async function seamOf(
  transport: StringTransport,
  options: JsonSeamOptions = {},
): Promise<FrameChannel> {
  const delivered = json1(partsOf(transport));
  return frameChannel(
    await handshake(delivered, {
      version: VERSION,
      timeoutMs: options.timeoutMs,
      ready: options.ready,
    }),
  );
}
