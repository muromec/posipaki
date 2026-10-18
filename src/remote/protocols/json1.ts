// ── json1 wire protocol ────────────────────────────────────────────────────
//
// One JSON object per frame: `{"$key": value}`. encode/decode turn a decoded
// frame object into a string and back. json1Channel wraps a StringTransport so
// it moves frame objects instead of strings.
//
// This is the boundary where the wire's bytes become a frame, and it is the one
// place a bad peer can throw into a callback that belongs to nobody but the host:
// the handler runs where the transport called it — a socket's `message` event, a
// line reader — so a `SyntaxError` here is an uncaught exception and takes the
// process down.  So a line that will not parse is not thrown at the caller: it
// becomes the frame that says so (`$bad`, channel.ts) and travels inward like any
// other, where the connection it came from can answer for it.
//
// One frame is one JSON *object*: a line that parses to a number, a string, an
// array or `null` is not a frame either, and reading one as a frame (`"$init" in 7`)
// throws just as surely as a line that never parsed.

import { badFrame, type Channel, type StringTransport } from "../channel.js";

export const VERSION = "json.v1";

/** The frames this protocol carries.  The shapes and the union are in channel.ts; a protocol
 *  owns that the connection speaks them, and how they are written down. */
export type { Frame } from "../channel.js";

export function encode(frame: Record<string, unknown>): string {
  return JSON.stringify(frame);
}

/** The frame a line carries, throwing on a line that is not JSON.  `readFrame` is how the
 *  seam reads a line; this is the primitive underneath it. */
export function decode(str: string): Record<string, unknown> {
  return JSON.parse(str);
}

/** A line read as a frame: the frame itself, or the frame that says this one could not be
 *  read.  Never throws — see the note at the top of this file. */
export function readFrame(str: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = decode(str);
  } catch (err) {
    return badFrame(err instanceof Error ? err.message : String(err), str);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return badFrame(`a frame is one JSON object, and this was ${kindOf(parsed)}`, str);
  }
  return parsed as Record<string, unknown>;
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * The octets a frame announces after it, or null when it announces none.
 *
 * One shape only: a chunk head carries the number of raw octets that follow, and that number
 * is what keeps the reader's framing.  A head without one is not a segment — it goes on as a
 * frame, and whoever reads it refuses it by name.
 */
export function announcedOctets(frame: Record<string, unknown>): number | null {
  const head = frame.$chunk;
  if (typeof head !== "object" || head === null) return null;
  const bytes = (head as { bytes?: unknown }).bytes;
  return typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 0 ? bytes : null;
}

export function json1Channel(transport: StringTransport): Channel {
  const frameReaders = new Set<(frame: Record<string, unknown>) => void>();
  const segmentReaders = new Set<(frame: Record<string, unknown>, bytes: Uint8Array) => void>();
  const closeReaders = new Set<() => void>();
  /** The wire goes once, whoever ends it: the peer hanging up, or this side closing it. */
  let closed = false;
  const sayClosed = (): void => {
    if (closed) return;
    closed = true;
    for (const reader of [...closeReaders]) reader();
  };
  /** The head whose octets are on their way: set between the line and the run it announced. */
  let expecting: Record<string, unknown> | null = null;

  const deliver = (frame: Record<string, unknown>): void => {
    // Over a copy: a reader that leaves as it is handed a frame must not cut the rest short.
    for (const reader of [...frameReaders]) reader(frame);
  };

  // Both handlers go on at once: the octets have to be read even when nobody is listening for
  // them, or the next line starts in the wrong place and the connection is lost.
  transport.onMessage((str) => {
    const frame = readFrame(str);
    const octets = announcedOctets(frame);
    if (octets === null) {
      deliver(frame);
      return;
    }
    expecting = frame;
    return octets;
  });
  transport.onBytes((bytes) => {
    const frame = expecting;
    expecting = null;
    // Octets nobody announced are a peer talking past the protocol: they are said out loud
    // rather than attached to whatever frame happened to arrive last.
    if (frame === null) {
      deliver(badFrame(`${bytes.length} octets arrived that no frame announced`, ""));
      return;
    }
    for (const reader of [...segmentReaders]) reader(frame, bytes);
  });
  transport.onClose(sayClosed);

  return {
    send(frame) {
      return transport.send(encode(frame));
    },
    onMessage(handler) {
      frameReaders.add(handler);
      return () => {
        frameReaders.delete(handler);
      };
    },
    async sendSegment(frame, bytes) {
      // The line first, then its octets, each written before the next is asked for: a chunk
      // that was queued behind a megabyte of earlier chunks is a chunk the writer ran ahead of
      // its reader with.
      await transport.send(encode(frame));
      await transport.sendBytes(bytes);
    },
    onSegment(handler) {
      segmentReaders.add(handler);
      return () => {
        segmentReaders.delete(handler);
      };
    },
    onClose(handler) {
      closeReaders.add(handler);
    },
    async close() {
      // Closing here is news to everyone above as well: a spawner ends the wire when its child dies,
      // and a client that was not told would wait for a peer that is already gone.
      sayClosed();
      await transport.close();
    },
  };
}
