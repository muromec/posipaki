// ── one actor over one channel ───────────────────────────────────────────────
//
// The subject is the window between the actor being ready and its channel existing: a send asked for in
// it is a frame the port has already been given, so it may not be dropped.

import { afterEach, describe, expect, it } from "vitest";

import { createRootTracker } from "../testing/index.js";
import type { Channel } from "./channel.js";
import { portActor } from "./actor.js";
import { memoryChannelPair } from "./memory.js";

const tracker = createRootTracker();

afterEach(async () => {
  await tracker.stopAll();
});

/** A port whose channel is made before it opens and handed over late: the window is the point. */
const SLOW_PORT = portActor<{ opened: Channel<Uint8Array>; waitMs: number }, Uint8Array, string>({
  name: "slow-port",
  open: async ({ opened, waitMs }) => {
    await new Promise((done) => setTimeout(done, waitMs));
    return opened;
  },
});

describe("portActor", () => {
  it("holds a send until the opener has answered", async () => {
    // `ready()` settles when the actor's loop starts, which happens before `open` resolves.  A send in
    // that window used to reach a null channel and disappear without a word.
    const pair = memoryChannelPair<Uint8Array>();
    const received: number[] = [];
    pair.far.onFrame((bytes) => received.push(bytes[0] ?? -1));

    const proc = await SLOW_PORT.spawn(
      { opened: pair.near, waitMs: 100 },
      { addPlugins: [tracker.plugin] },
    );
    await proc.ready();
    proc.send({ type: "SEND", data: new Uint8Array([7]) });

    const until = Date.now() + 2_000;
    while (received.length === 0 && Date.now() < until) {
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(received).toEqual([7]);
    await proc.stop();
  });
});
