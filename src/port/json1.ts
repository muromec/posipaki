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

