// ── the splitter ────────────────────────────────────────────────────────────
//
// Bytes in, parts out, over the in-memory pair.  Each case is a rule every byte medium would otherwise have to
// implement for itself.

import { describe, expect, it } from "vitest";

import type { Part } from "./channel.js";
import { memoryChannelPair } from "./memory.js";
import { splitChannel } from "./split.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A splitter over a memory pair, and what it hands up. */
function harness(announced?: (line: string) => number | null) {
  const { near, far } = memoryChannelPair<Uint8Array>();
  const parts = splitChannel(far, announced);
  const read: Part[] = [];
  parts.onFrame((part) => read.push(part));
  return { near, parts, read };
}

describe("a splitter", () => {
  it("cuts one chunk into its lines", async () => {
    const { near, read } = harness();
    await near.send(bytes("one\ntwo\nthree\n"));

    expect(read).toEqual([
      { line: "one", bytes: null },
      { line: "two", bytes: null },
      { line: "three", bytes: null },
    ]);
  });

  it("holds a line that is not finished yet", async () => {
    const { near, read } = harness();
    await near.send(bytes("hal"));
    expect(read).toEqual([]);
    await near.send(bytes("f a line\n"));

    expect(read).toEqual([{ line: "half a line", bytes: null }]);
  });

  it("keeps a character that straddles two chunks whole", async () => {
    const { near, read } = harness();
    const cafe = bytes("café\n");
    await near.send(cafe.subarray(0, 4));
    await near.send(cafe.subarray(4));

    expect(read).toEqual([{ line: "café", bytes: null }]);
  });

  it("reads CRLF as one ending", async () => {
    const { near, read } = harness();
    await near.send(bytes("one\r\ntwo\r\n"));

    expect(read.map((part) => part.line)).toEqual(["one", "two"]);
  });

  it("hands over the octets a line announced, and frames the next line after them", async () => {
    const { near, read } = harness((line) => (line.startsWith("{chunk") ? 3 : null));
    await near.send(new Uint8Array([...bytes("{chunk}\n"), 1, 2, 3, ...bytes("next\n")]));

    expect(read).toHaveLength(2);
    expect(read[0]?.line).toBe("{chunk}");
    expect([...(read[0]?.bytes ?? new Uint8Array())]).toEqual([1, 2, 3]);
    expect(read[1]).toEqual({ line: "next", bytes: null });
  });

  it("waits for octets that arrive in a later chunk", async () => {
    const { near, read } = harness((line) => (line === "head" ? 2 : null));
    await near.send(new Uint8Array([...bytes("head\n"), 7]));
    expect(read).toEqual([]);
    await near.send(new Uint8Array([8, ...bytes("after\n")]));

    expect(read[0]?.line).toBe("head");
    expect([...(read[0]?.bytes ?? new Uint8Array())]).toEqual([7, 8]);
    expect(read[1]?.line).toBe("after");
  });

  it("writes a part back as the bytes it came from", async () => {
    const { near, parts } = harness();
    const seen: Uint8Array[] = [];
    near.onFrame((chunk) => seen.push(chunk));

    await parts.send({ line: "hello", bytes: null });
    await parts.send({ line: "head", bytes: new Uint8Array([9, 9]) });

    expect(Buffer.concat(seen.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe(
      "hello\nhead\n\u0009\u0009",
    );
  });

  it("keeps the last word of a peer that wrote and hung up", async () => {
    const { near, parts } = harness();
    const read: Part[] = [];
    parts.onFrame((part) => read.push(part));
    await near.send(bytes("no terminator"));
    await near.close("done");

    expect(read).toEqual([{ line: "no terminator", bytes: null }]);
  });
});
