// ── json.v1: a line, and the frame it carries ───────────────────────────────
//
// One JSON object per line.  This file owns the encoding and the one thing it has to get right: a line that
// will not parse must not throw.  A frame is read inside the transport's own callback — a stream's line
// reader, a socket's message event — where a throw belongs to nobody: it arrives at the host as an uncaught
// exception, and one unreadable line from one peer takes the process down with every other connection in it.
// An unreadable line is the connection's business, so it is carried inward as a frame that says so (`$bad`),
// and whoever owns the connection can answer for it.
//
// One frame is one JSON *object*: a line that parses to a number, a string, an array or `null` is not a frame
// either, and reading one as a frame throws just as surely as a line that never parsed.
//
// A line may announce octets after it, and the splitter pairs them with their line before this adapter sees
// either.  So a decoded message is a frame and the octets it came with — one value, not a frame plus a
// callback.  That is what lets a chunk of a stream be a single thing on a channel whose frame type says so.

import type { Channel, Part } from "./channel.js";

const BAD_KEY = "$bad";

/** How much of an unreadable line is carried: enough to see what it was, never enough to be it.
 *  A line that failed to parse is the one line nobody vouched for, so quoting it whole would move
 *  whatever it holds — a credential in a paste accident is how that happens — into every log,
 *  transcript and context window that later reads the frame.  Why, how long, and a short head of
 *  it.  (`reason` carries a little of the line on its own: a JSON parser says where it gave up and
 *  quotes what it was looking at.  That is the parser's business, not a promise this file makes.) */
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
 * A part is one line and its octets, so a message is decoded into a frame and the octets it arrived with —
 * nothing is remembered between reads and no second callback is needed to pair them.  What the frame means,
 * and whether the octets follow from it, is above this in the protocol that wrote them.
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
