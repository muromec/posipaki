// ── a channel that keeps what nobody was reading yet ────────────────────────

import { describe, expect, it } from "vitest";

import { held } from "./held.js";
import { memoryChannelPair } from "./memory.js";

describe("held", () => {
  it("gives what arrived before the first subscriber to every subscriber that follows", async () => {
    const { near, far } = memoryChannelPair<string>();
    const kept = held(far);
    await near.send("one");
    await near.send("two");

    const first: string[] = [];
    const second: string[] = [];
    kept.onFrame((frame) => first.push(frame));
    kept.onFrame((frame) => second.push(frame));

    expect(first).toEqual(["one", "two"]);
    expect(second).toEqual(["one", "two"]);
  });

  it("stops keeping once a frame has been delivered", async () => {
    const { near, far } = memoryChannelPair<string>();
    const kept = held(far);
    await near.send("before");

    const first: string[] = [];
    kept.onFrame((frame) => first.push(frame));
    await near.send("live");

    const second: string[] = [];
    kept.onFrame((frame) => second.push(frame));
    await near.send("after");

    expect(first).toEqual(["before", "live", "after"]);
    expect(second).toEqual(["after"]);
  });

  it("passes the ending through", async () => {
    const { near, far } = memoryChannelPair<string>();
    const kept = held(far);
    const endings: string[] = [];
    kept.onClose((reason) => endings.push(reason));
    await near.close("done");
    expect(endings).toEqual(["done"]);
  });
});
