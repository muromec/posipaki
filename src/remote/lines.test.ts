// ── the line reader ────────────────────────────────────────────────────────
//
// A transport's reader is a promise about framing: whatever the chunks look like, the
// frames come out as the peer wrote them.  These are the cases the wire actually
// produces — a frame split across two reads, a character split across two reads, the
// last line with no newline after it — plus the two a protocol has to tolerate.

import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";

import { readLines } from "./lines.js";

/** Feed the stream the given chunks and collect what the reader made of them. */
function linesOf(chunks: Array<string | Uint8Array>): { lines: string[]; ended: () => boolean } {
  const stream = new PassThrough();
  const lines: string[] = [];
  let ended = false;
  readLines(
    stream,
    (line) => lines.push(line),
    () => {
      ended = true;
    },
  );
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return { lines, ended: () => ended };
}

describe("readLines", () => {
  it("reads frames that arrive whole", async () => {
    const { lines } = linesOf(['{"a":1}\n', '{"a":2}\n']);
    await new Promise((done) => setImmediate(done));
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("joins a frame split across reads", async () => {
    const { lines } = linesOf(['{"$b":{"id":', '7,"size":1}}\n']);
    await new Promise((done) => setImmediate(done));
    expect(lines).toEqual(['{"$b":{"id":7,"size":1}}']);
  });

  it("keeps a character whose bytes straddle a read", async () => {
    const bytes = Buffer.from('{"name":"ไฟ"}\n', "utf8");
    const cut = bytes.indexOf(Buffer.from("ไ", "utf8")) + 1; // inside the three-byte character
    const { lines } = linesOf([bytes.subarray(0, cut), bytes.subarray(cut)]);
    await new Promise((done) => setImmediate(done));
    expect(lines).toEqual(['{"name":"ไฟ"}']);
  });

  it("gives up the last line of a stream that ends without a newline", async () => {
    const { lines, ended } = linesOf(['{"a":1}\n{"a":2}']);
    await new Promise((done) => setImmediate(done));
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
    expect(ended()).toBe(true);
  });

  it("reads CRLF as an ending, and a blank line as an empty frame", async () => {
    const { lines } = linesOf(['{"a":1}\r\n', "\n", '{"a":2}\n']);
    await new Promise((done) => setImmediate(done));
    expect(lines).toEqual(['{"a":1}', "", '{"a":2}']);
  });

  it("stops when it is told to", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const reader = readLines(stream, (line) => lines.push(line));
    stream.write('{"a":1}\n');
    reader.stop();
    stream.write('{"a":2}\n');
    reader.stop();
    await new Promise((done) => setImmediate(done));
    expect(lines).toEqual(['{"a":1}']);
  });
});
