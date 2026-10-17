// ── lines on a byte stream ─────────────────────────────────────────────────
//
// A line transport's reader, and the number that made it a file of its own: 13.3 MB of
// 87 KB frames read through `node:readline` costs 4.0 s on this box, and through a buffer
// and an `indexOf` it costs 76 ms.  The difference is not the parsing — it is that a
// frame the size of a file chunk is the normal case here and readline is built for the
// other one.
//
// Splitting on the byte 0x0a is safe for UTF-8: a continuation byte is never 0x0a, so a
// line boundary cannot fall inside a character, and a chunk boundary inside one is
// carried by the accumulator until the rest of it arrives.
//
// CRLF is read as a line ending rather than as part of the frame, which is what the line
// reader it replaces did; the frames this library writes end in "\n" alone.

import type { Readable } from "node:stream";

/** A line reader, and the one way to stop it. */
export interface LineReader {
  /** Stop reading and drop what is buffered.  Idempotent. */
  stop(): void;
}

const NL = 0x0a;
const CR = 0x0d;

/**
 * Read `stream` a line at a time.
 *
 * `onLine` sees every line the stream carried, an empty one included, exactly as
 * `readline` would have reported them — a blank line is a frame nobody wrote, and what to
 * do about it is the protocol's business.  `onEnd` is called once when the stream is over,
 * after the last line: a stream that ends without its final newline still gives up its
 * last line, because that is what the peer meant to say.
 */
export function readLines(stream: Readable, onLine: (line: string) => void, onEnd?: () => void): LineReader {
  let acc: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stopped = false;

  const deliver = (line: Buffer<ArrayBufferLike>): void => {
    onLine(line.toString("utf8"));
  };

  const onData = (chunk: Buffer | string): void => {
    if (stopped) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    acc = acc.length === 0 ? bytes : Buffer.concat([acc, bytes]);
    for (;;) {
      const at = acc.indexOf(NL);
      if (at < 0) return;
      const line = acc.subarray(0, at);
      acc = acc.subarray(at + 1);
      deliver(line.length > 0 && line[line.length - 1] === CR ? line.subarray(0, line.length - 1) : line);
    }
  };

  const finish = (): void => {
    if (stopped) return;
    const rest = acc;
    acc = Buffer.alloc(0);
    stopped = true;
    stream.off("data", onData);
    if (rest.length > 0) deliver(rest[rest.length - 1] === CR ? rest.subarray(0, rest.length - 1) : rest);
    onEnd?.();
  };

  stream.on("data", onData);
  stream.once("end", finish);

  return {
    stop(): void {
      stopped = true;
      stream.off("data", onData);
      stream.off("end", finish);
      acc = Buffer.alloc(0);
    },
  };
}
