// ── a pair of channels as one ───────────────────────────────────────────────

import { describe, expect, it } from "vitest";

import { duplexChannel } from "./duplex.js";
import { memoryChannelPair } from "./memory.js";

function pair() {
  const inbound = memoryChannelPair<string>();
  const outbound = memoryChannelPair<string>();
  return {
    inbound,
    outbound,
    channel: duplexChannel({ inbound: inbound.far, outbound: outbound.far }),
  };
}

describe("duplexChannel", () => {
  it("delivers what the far side sent, and writes what is sent to it", async () => {
    const { inbound, outbound, channel } = pair();
    const arrived: string[] = [];
    const written: string[] = [];
    channel.onFrame((frame) => arrived.push(frame));
    outbound.near.onFrame((frame) => written.push(frame));

    await inbound.near.send("in");
    await channel.send("out");

    expect(arrived).toEqual(["in"]);
    expect(written).toEqual(["out"]);
  });

  it("ends with the inbound side, carrying what it said", async () => {
    const { inbound, channel } = pair();
    const endings: string[] = [];
    channel.onClose((reason) => endings.push(reason));

    await inbound.near.close("all sent");

    expect(endings).toEqual(["all sent"]);
  });

  it("closing it ends the outbound side, which is how an answer is finished", async () => {
    const { outbound, channel } = pair();
    const endings: string[] = [];
    outbound.near.onClose((reason) => endings.push(reason));

    await channel.close("done");

    expect(endings).toEqual(["done"]);
  });
});
