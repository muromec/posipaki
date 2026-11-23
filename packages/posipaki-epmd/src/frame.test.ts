// ── frames: the length a packet announces ──────────────────────────────────
//
// Two ends over nothing: what one side sends is what the other reads, cut the way the wire cuts it. No socket,
// because the framing is not the medium's business.

import { describe, expect, it } from "vitest";

import { memoryChannelPair } from "posipaki/port";

import { wrapEpmdFrame } from "./frame.js";

const text = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "utf8"));
const said = (frame: Uint8Array): string => Buffer.from(frame).toString("utf8");

/** A framed channel over a memory pair, and the other end. */
function pair() {
  const ends = memoryChannelPair<Uint8Array>();
  return { framed: wrapEpmdFrame(ends.near), wire: ends.far };
}

/** Everything a channel hands out, as it arrives. */
function collected(channel: {
  onFrame(handler: (frame: Uint8Array) => void): () => void;
}): Uint8Array[] {
  const seen: Uint8Array[] = [];
  channel.onFrame((frame) => seen.push(frame));
  return seen;
}

describe("wrapEpmdFrame", () => {
  it("cuts a frame out of chunks that arrive apart", async () => {
    const { framed, wire } = pair();
    const seen = collected(framed);
    await wire.send(new Uint8Array([0]));
    await wire.send(new Uint8Array([5, 0x68]));
    await wire.send(text("ello"));
    expect(seen.map(said)).toEqual(["hello"]);
  });

  it("cuts two frames out of one chunk", async () => {
    const { framed, wire } = pair();
    const seen = collected(framed);
    await wire.send(new Uint8Array([0, 2, ...text("hi"), 0, 3, ...text("bye")]));
    expect(seen.map(said)).toEqual(["hi", "bye"]);
  });

  it("writes the length a frame needs", async () => {
    const { framed, wire } = pair();
    const written = collected(wire);
    await framed.send(text("hello"));
    expect([...written[0] ?? []]).toEqual([0, 5, ...text("hello")]);
  });

  it("widens to four bytes, and cuts them", async () => {
    const { framed, wire } = pair();
    const seen = collected(framed);
    framed.use(4);
    expect(framed.prefix).toBe(4);
    await wire.send(new Uint8Array([0, 0, 0, 5, ...text("hello")]));
    expect(seen.map(said)).toEqual(["hello"]);
  });

  it("carries a frame too long for two bytes once the width is four", async () => {
    const { framed, wire } = pair();
    const written = collected(wire);
    framed.use(4);
    await framed.send(new Uint8Array(70_000).fill(0x61));
    expect(written[0]?.length).toBe(4 + 70_000);
    expect([...(written[0]?.slice(0, 4) ?? [])]).toEqual([0, 1, 0x11, 0x70]);
  });

  it("refuses a frame longer than its width can announce", async () => {
    const { framed } = pair();
    await expect(framed.send(new Uint8Array(0x1_0000))).rejects.toThrow(
      "a 2-byte length cannot announce 65536 octets",
    );
  });

  it("refuses to widen with octets of a frame still buffered", async () => {
    const { framed, wire } = pair();
    await wire.send(new Uint8Array([0]));
    expect(() => framed.use(4)).toThrow("cannot change from 2 to 4");
  });
});
