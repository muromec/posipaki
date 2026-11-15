// ── octets, as lines ────────────────────────────────────────────────────────
//
// A line is handed over once its newline has arrived; what follows the last newline waits for the next read, so a
// half-written line is not a line.  Sent, a line is its octets and a newline.
//
// This is `splitChannel` with the announcement dropped: the cutting, the buffering of a half line and the decoding
// of a character that straddles two chunks are the splitter's, and this file adds nothing but the vocabulary.

import type { Channel } from "./channel.js";
import { mapChannel } from "./map.js";
import { splitChannel } from "./split.js";

/** A channel of octets, read and written as lines. */
export function linesChannel<C = string>(inner: Channel<Uint8Array, C>): Channel<string, C> {
  return mapChannel(
    splitChannel(inner),
    (line: string): { line: string; bytes: null } => ({ line, bytes: null }),
    (part): string => part.line,
  );
}
