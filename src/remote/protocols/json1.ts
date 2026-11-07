// ── json1 wire protocol ────────────────────────────────────────────────────
//
// One JSON object per frame: `{"$key": value}`.  `encode` and `decode` turn a decoded frame object into a string
// and back.  `json1Channel` wraps a `StringTransport` so it moves frame objects instead of strings; the stdio and
// gateway wires still use it, while the remote seam composes `json1` over a port.
//
// A line that will not parse must not throw.  The handler runs where the transport called it, a socket's
// `message` event or a line reader, so a `SyntaxError` here is an uncaught exception that takes the process down
// with every other connection in it.  Such a line becomes the frame that says so (`$bad`, channel.ts) and
// travels inward, where the connection it came from can answer for it.
//
// One frame is one JSON *object*.  A line that parses to a number, a string, an array or `null` is not a frame
// either, and `"$init" in 7` throws as surely as a line that never parsed.


import type { Channel, Part } from "../../port/index.js";
import type { Channel as FrameChannel, StringTransport } from "../channel.js";
const BAD_KEY = "$bad";

/** How much of an unreadable line is carried: enough to see what it was, never enough to be all of it.
 *  A line that failed to parse is the one line nobody vouched for, so quoting it whole would move whatever it
 *  holds — a credential pasted by accident — into every log, transcript and context window that reads the
 *  frame.  `reason` says why; this says how long it was and keeps a short head. */
export const BAD_PREFIX_LIMIT = 32;

export type BadFrame = {
  $bad: { reason: string };
};

export function isBad(msg: Record<string, unknown>): msg is BadFrame {
  return BAD_KEY in msg;
}

/** The frame that says a frame could not be read: why, how long it was, and the head of it. */
export function badFrame(reason: string, raw: string): Record<string, unknown> {
  const prefix = raw.length > BAD_PREFIX_LIMIT ? `${raw.slice(0, BAD_PREFIX_LIMIT)}…` : raw;
  return { [BAD_KEY]: { reason, length: raw.length, prefix } };
}

/** Why a frame could not be read, or null when it is not a frame that says so. */
export function badReason(msg: Record<string, unknown>): string | null {
  const body = msg[BAD_KEY];
  if (typeof body !== "object" || body === null) return null;
  const reason = (body as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

export function encode(frame: Record<string, unknown>): string {
  return JSON.stringify(frame);
}

/** The frame a line carries, throwing on a line that is not JSON.  `readFrame` is how a wire reads a line;
 *  this is the primitive underneath it. */
export function decode(str: string): Record<string, unknown> {
  return JSON.parse(str);
}

/** A line read as a frame: the frame itself, or the frame that says this one could not be read.  Never
 *  throws — see the note at the top of this file. */
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

/** One message off the wire: the frame a line decoded to, and the octets that line announced. */
export interface Delivered {
  frame: Record<string, unknown>;
  bytes: Uint8Array | null;
}

/**
 * Text into frames, and frames back into text.
 *
 * A part is one line and its octets, so a message decodes to a frame and the octets it arrived with: nothing is
 * remembered between reads, and no second callback pairs them.  What a frame means, and how many octets follow
 * it, belongs to the protocol above.
 */
export function json1(parts: Channel<Part>): Channel<Delivered> {
  const readers = new Set<(value: Delivered) => void>();
  const closers = new Set<(reason: string) => void>();
  const failers = new Set<(error: unknown) => void>();

  parts.onFrame((part) => {
    const value: Delivered = { frame: readFrame(part.line), bytes: part.bytes };
    for (const reader of [...readers]) reader(value);
  });
  parts.onError((error) => {
    for (const failer of [...failers]) failer(error);
  });
  parts.onClose((reason) => {
    for (const closer of [...closers]) closer(reason);
  });

  return {
    send: (value: Delivered) => parts.send({ line: encode(value.frame), bytes: value.bytes }),
    onFrame: (handler) => {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    onClose: (handler) => {
      closers.add(handler);
      return () => {
        closers.delete(handler);
      };
    },
    onError: (handler) => {
      failers.add(handler);
      return () => {
        failers.delete(handler);
      };
    },
    close: (reason?: string) => parts.close(reason),
  };
}
export const VERSION = "json.v1";

/** The frames this protocol carries.  The shapes and the union are in channel.ts; a protocol
 *  owns that the connection speaks them, and how they are written down. */
export type { Frame } from "../channel.js";

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

export function json1Channel(transport: StringTransport): FrameChannel {
  const frameReaders = new Set<(frame: Record<string, unknown>) => void>();
  const segmentReaders = new Set<(frame: Record<string, unknown>, bytes: Uint8Array) => void>();
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
      transport.onClose(handler);
    },
    close() {
      return transport.close();
    },
  };
}
