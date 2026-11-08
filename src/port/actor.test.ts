// ── one actor over one channel ───────────────────────────────────────────────
//
// The subject is when the channel exists: the port opens it in `setup`, which the runtime awaits, so an
// actor that is ready has a channel and a send is never asked to wait for one.

import { afterEach, describe, expect, it } from "vitest";

import { createRootTracker } from "../testing/index.js";
import type { Channel } from "./channel.js";
import { portActor } from "./actor.js";
import { memoryChannelPair } from "./memory.js";

const tracker = createRootTracker();

afterEach(async () => {
  await tracker.stopAll();
});

/** A port whose channel is handed over late: that the opening happens before readiness is the point. */
const SLOW_PORT = portActor<{ opened: Channel<Uint8Array>; waitMs: number }, Uint8Array, string>({
  name: "slow-port",
  open: async ({ opened, waitMs }) => {
    await new Promise((done) => setTimeout(done, waitMs));
    return opened;
  },
});

/** A port that cannot open at all: nothing to send to, and no reason to look alive. */
const REFUSED_PORT = portActor<{ why: string }, Uint8Array, string>({
  name: "refused-port",
  open: async ({ why }) => {
    throw new Error(why);
  },
});

describe("portActor", () => {
  it("has its channel before it is ready, so a send is not waiting for one", async () => {
    const pair = memoryChannelPair<Uint8Array>();
    const received: number[] = [];
    pair.far.onFrame((bytes) => received.push(bytes[0] ?? -1));

    const proc = await SLOW_PORT.spawn(
      { opened: pair.near, waitMs: 100 },
      { addPlugins: [tracker.plugin] },
    );
    await proc.ready();
    expect(proc.state?.alive).toBe(true);

    proc.send({ type: "SEND", data: new Uint8Array([7]) });
    const until = Date.now() + 2_000;
    while (received.length === 0 && Date.now() < until) {
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(received).toEqual([7]);
    await proc.stop();
  });

  it("refuses to start when its channel cannot be opened", async () => {
    // A port that could not open has nothing to carry: failing the start says so, where a port that
    // looked alive and silent would have been the bug.
    await expect(
      REFUSED_PORT.spawn({ why: "no socket there" }, { addPlugins: [tracker.plugin] }),
    ).rejects.toThrow(/no socket there/);
  });
});
