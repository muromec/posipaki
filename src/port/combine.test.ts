// ── several channels as one ─────────────────────────────────────────────────
//
// Memory pairs, because what is under test is the combination and not a medium: which frame came from where,
// and which ending ends the whole thing.

import { describe, expect, it } from "vitest";

import { all, settled, type Ended, type Sourced } from "./combine.js";
import { memoryChannelPair } from "./memory.js";

describe("all", () => {
  it("tags every frame with the channel it came from", async () => {
    const left = memoryChannelPair<string>();
    const right = memoryChannelPair<string>();
    const combined = all({ left: left.far, right: right.far });
    const read: Array<Sourced<"left" | "right", string>> = [];
    combined.onFrame((frame) => read.push(frame));

    await left.near.send("a");
    await right.near.send("b");

    expect(read).toEqual([
      { source: "left", frame: "a" },
      { source: "right", frame: "b" },
    ]);
  });

  it("ends with the first ending, and the second is ignored", async () => {
    const left = memoryChannelPair<string>();
    const right = memoryChannelPair<string>();
    const combined = all({ left: left.far, right: right.far });
    const endings: string[] = [];
    combined.onClose((reason) => endings.push(reason));

    await left.near.close("left is done");
    await right.near.close("right is done");

    expect(endings).toEqual(["left is done"]);
  });

  it("refuses a frame of its own: there is nowhere to put it", async () => {
    const left = memoryChannelPair<string>();
    const combined = all({ left: left.far });
    await expect(combined.send({ source: "left", frame: "x" })).rejects.toThrow(/send on one of them/);
  });
});

describe("settled", () => {
  it("delivers every ending as a frame, tagged, then closes", async () => {
    const left = memoryChannelPair<string>();
    const right = memoryChannelPair<string>();
    const combined = settled({ left: left.far, right: right.far });
    const read: Array<Sourced<"left" | "right", string> | Ended<"left" | "right", string>> = [];
    combined.onFrame((frame) => read.push(frame));
    const closed = new Promise<void>((resolve) => combined.onClose(() => resolve()));

    await left.near.close("one");
    await right.near.close("two");
    await closed;

    expect(read).toEqual([
      { source: "left", ending: "one" },
      { source: "right", ending: "two" },
    ]);
  });

  it("stays open while one of them is", async () => {
    const left = memoryChannelPair<string>();
    const right = memoryChannelPair<string>();
    const combined = settled({ left: left.far, right: right.far });
    let closed = false;
    combined.onClose(() => {
      closed = true;
    });

    await left.near.close("only left");
    expect(closed).toBe(false);

    await right.near.close("now right");
    expect(closed).toBe(true);
  });
});
