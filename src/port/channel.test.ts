// ── a channel ───────────────────────────────────────────────────────────────
//
// The contract every medium, adapter and protocol is written against.  Exercised over the in-memory pair, so a
// failure names the contract rather than a socket or a child.

import { describe, expect, it } from "vitest";

import { ChannelClosed } from "./channel.js";
import { memoryChannelPair } from "./memory.js";

describe("a channel", () => {
  it("hands what one end sends to the other", async () => {
    const { near, far } = memoryChannelPair<string>();
    const read: string[] = [];
    far.onFrame((frame) => read.push(frame));

    await near.send("one");
    await near.send("two");

    expect(read).toEqual(["one", "two"]);
  });

  it("gives every reader the same frame, and one leaving does not silence another", async () => {
    const { near, far } = memoryChannelPair<number>();
    const first: number[] = [];
    const second: number[] = [];
    const stop = first.push.bind(first);
    const off = far.onFrame((frame) => stop(frame));
    far.onFrame((frame) => second.push(frame));

    await near.send(1);
    off();
    await near.send(2);

    expect(first).toEqual([1]);
    expect(second).toEqual([1, 2]);
  });

  it("says the far end closed, once, and leaves the closing side's readers alone", async () => {
    const { near, far } = memoryChannelPair<string>();
    const heardNear: string[] = [];
    const heardFar: string[] = [];
    near.onClose((reason) => heardNear.push(reason));
    far.onClose((reason) => heardFar.push(reason));

    await near.close("done here");
    await near.close("again");

    expect(heardFar).toEqual(["done here"]);
    expect(heardNear).toEqual([]);
  });

  it("reports a wire failure, and then the close", async () => {
    const { near, far } = memoryChannelPair<string>();
    const seen: string[] = [];
    far.onError((error) => seen.push(`error: ${String(error)}`));
    far.onClose((reason) => seen.push(`close: ${reason}`));

    near.fail(new Error("the pipe broke"));

    expect(seen).toEqual(["error: Error: the pipe broke", "close: the wire failed"]);
  });

  it("refuses a frame once the channel is over, whichever side ended it", async () => {
    const ended = memoryChannelPair<string>();
    await ended.near.close("done");
    await expect(ended.near.send("late")).rejects.toBeInstanceOf(ChannelClosed);
    await expect(ended.far.send("late")).rejects.toBeInstanceOf(ChannelClosed);

    const broken = memoryChannelPair<string>();
    broken.far.fail(new Error("the pipe broke"));
    await expect(broken.near.send("late")).rejects.toThrow("the channel is closed: the wire failed");
  });

  it("lets a reader go without ending the channel", async () => {
    const { near, far } = memoryChannelPair<string>();
    const read: string[] = [];
    far.onFrame((frame) => read.push(frame))();
    await near.send("nobody is listening");

    expect(read).toEqual([]);
    await expect(near.send("still open")).resolves.toBeUndefined();
  });
});
