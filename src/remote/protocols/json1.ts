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

export function json1Channel(transport: StringTransport): Channel {
  return {
    send(frame) {
      return transport.send(encode(frame));
    },
    onMessage(handler) {
      transport.onMessage((str) => handler(readFrame(str)));
    },
    removeHandler() {
      transport.removeHandler();
    },
    onClose(handler) {
      transport.onClose(handler);
    },
    close() {
      return transport.close();
    },
  };
}
