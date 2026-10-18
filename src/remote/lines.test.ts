// ── the line reader ────────────────────────────────────────────────────────
//
// A transport's reader is a promise about framing: whatever the chunks look like, the
// frames come out as the peer wrote them.  These are the cases the wire actually
// produces — a frame split across two reads, a character split across two reads, the
// last line with no newline after it — plus the two a protocol has to tolerate.

import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";

import { readLines, readParts } from "./lines.js";

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

describe("readParts", () => {
  /** Feed the stream the given chunks; collect the lines and the octets the reader made of them. */
  function partsOf(
    chunks: Array<string | Uint8Array>,
    announce: (line: string) => number | void,
  ): { lines: string[]; octets: Uint8Array[]; ended: () => boolean } {
    const stream = new PassThrough();
    const lines: string[] = [];
    const octets: Uint8Array[] = [];
    let ended = false;
    readParts(
      stream,
      (line) => {
        lines.push(line);
        return announce(line);
      },
      (bytes) => octets.push(bytes),
      () => {
        ended = true;
      },
    );
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
    return { lines, octets, ended: () => ended };
  }

  const asText = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

  it("hands over the octets a line announced, however they arrive", async () => {
    const { lines, octets } = partsOf(
      ["{\"$chunk\":{\"bytes\":4}}\n", "ab", "c", "d", '{"$chunkEnd":1}\n'],
      (line) => (line === '{"$chunk":{"bytes":4}}' ? 4 : undefined),
    );
    await new Promise((done) => setImmediate(done));
    expect(lines).toEqual(['{"$chunk":{"bytes":4}}', '{"$chunkEnd":1}']);
    expect(octets.map(asText)).toEqual(["abcd"]);
  });

  it("keeps octets that contain a line ending", async () => {
    // The reason the length is announced: a run of bytes is not text and is not split.
    const bytes = Buffer.from([0x61, 0x0a, 0x62, 0x0d, 0x0a, 0x63]);
    const { lines, octets } = partsOf([`{"$chunk":{"bytes":${bytes.length}}}\n`, bytes, '{"x":1}\n'], () =>
      bytes.length,
    );
    await new Promise((done) => setImmediate(done));
    expect(octets).toHaveLength(1);
    expect(Buffer.from(octets[0]!).equals(bytes)).toBe(true);
    expect(lines).toEqual([`{"$chunk":{"bytes":${bytes.length}}}`, '{"x":1}']);
  });

  it("reads a run that arrives in the same chunk as its line", async () => {
    const { octets } = partsOf([`{"$chunk":{"bytes":3}}\nxyz`], () => 3);
    await new Promise((done) => setImmediate(done));
    expect(octets.map(asText)).toEqual(["xyz"]);
  });

  it("carries several runs on one stream", async () => {
    const { octets } = partsOf(['{"$chunk":{"bytes":2}}\n', "ab", '{"$chunk":{"bytes":2}}\n', "cd"], () => 2);
    await new Promise((done) => setImmediate(done));
    expect(octets.map(asText)).toEqual(["ab", "cd"]);
  });
});

describe("a stream that vanishes", () => {
  it("ends the reader when the pipe is destroyed rather than closed", async () => {
    const stream = new PassThrough();
    let ended = false;
    readLines(
      stream,
      () => {},
      () => {
        ended = true;
      },
    );
    stream.write("half a frame, no newline");

    // A socket the far side destroys reports `close` and an error, never `end`: a reader that waits
    // for the polite one waits forever, and the connection it belonged to is never seen to go.
    stream.destroy();

    await new Promise((done) => setImmediate(done));
    expect(ended).toBe(true);
  });
});
