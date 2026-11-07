// ── json.v1 ─────────────────────────────────────────────────────────────────
//
// A line carries one JSON object; a line that is not one becomes a frame that says so, not a throw inside a
// transport's callback.  Exercised over the memory pair: the encoding has no medium of its own.

import { describe, expect, it } from "vitest";

import type { Part } from "./channel.js";
import { badReason, json1 } from "./json1.js";
import { memoryChannelPair } from "./memory.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function harness() {
  const { near, far } = memoryChannelPair<Part>();
  const wire = json1(far);
  const read: { frame: Record<string, unknown>; bytes: Uint8Array | null }[] = [];
  wire.onFrame((value) => read.push(value));
  return { near, wire, read };
}

describe("json.v1", () => {
  it("turns a line into its frame", async () => {
    const { near, read } = harness();
    await near.send({ line: '{"$msg":{"body":1}}', bytes: null });

    expect(read).toEqual([{ frame: { $msg: { body: 1 } }, bytes: null }]);
  });

  it("turns a frame back into its line", async () => {
    const { near, wire } = harness();
    const sent: Part[] = [];
    near.onFrame((part) => sent.push(part));

    await wire.send({ frame: { $msg: { body: 1 } }, bytes: null });

    expect(sent).toEqual([{ line: '{"$msg":{"body":1}}', bytes: null }]);
  });

  it("answers a line that will not parse, and throws nothing", async () => {
    const { near, read } = harness();
    await near.send({ line: "{not json", bytes: null });

    expect(badReason(read[0]!.frame)).toBeTruthy();
  });

  it("refuses a line that parsed into something other than an object", async () => {
    const { near, read } = harness();
    await near.send({ line: "[1,2]", bytes: null });
    await near.send({ line: "7", bytes: null });

    expect(read.map((value) => badReason(value.frame))).toEqual([
      "a frame is one JSON object, and this was an array",
      "a frame is one JSON object, and this was a number",
    ]);
  });

  it("carries the octets a line announced with the frame itself", async () => {
    const { near, read } = harness();
    await near.send({ line: '{"$chunk":{"id":1,"seq":0,"bytes":3}}', bytes: bytes("abc") });

    expect(read).toEqual([
      { frame: { $chunk: { id: 1, seq: 0, bytes: 3 } }, bytes: bytes("abc") },
    ]);
  });

  it("sends a frame and its octets as one part", async () => {
    const { near, wire } = harness();
    const sent: Part[] = [];
    near.onFrame((part) => sent.push(part));

    await wire.send({ frame: { $chunk: { id: 1, seq: 0, bytes: 3 } }, bytes: bytes("abc") });

    expect(sent).toEqual([{ line: '{"$chunk":{"id":1,"seq":0,"bytes":3}}', bytes: bytes("abc") }]);
  });

  it("hands a close on to whoever is reading above it", async () => {
    const { near, wire } = harness();
    const reasons: string[] = [];
    wire.onClose((reason) => reasons.push(reason));

    await near.close("done here");
    await new Promise((resolve) => setImmediate(resolve));

    expect(reasons).toEqual(["done here"]);
  });
});
