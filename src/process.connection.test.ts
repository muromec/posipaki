// ── the connection a process holds ──────────────────────────────────────────
//
// `ctx.connection` is the process's own fact, like `pname`: stated at spawn so it is there
// from `setup` on, and taken by a process that opens a connection for itself.

import { describe, it, expect } from "vitest";
import { defineActor } from "./define-actor.js";
import type { FrameChannel } from "./types.js";

/** A connection that carries nothing: these tests are about the handle, not the frames. */
function fakeChannel(): FrameChannel & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    send(frame: Record<string, unknown>) {
      sent.push(frame);
    },
    onMessage() {
      return () => {};
    },
    onClose() {},
    async close() {},
  };
}

/** An actor that reports the connection it holds, and nothing else. */
function holder(onSetup: (connection: FrameChannel | null) => void) {
  return defineActor({
    name: "holder",
    handlers: {},
    setup() {
      onSetup(this.ctx.connection);
      return {};
    },
  });
}

describe("the connection a process holds", () => {
  it("is what the spawner stated, from setup on", async () => {
    const channel = fakeChannel();
    let readInSetup: FrameChannel | null | "never read" = "never read";
    const Holder = holder((connection) => {
      readInSetup = connection;
    });

    const proc = await Holder.spawn({}, { connection: channel });

    expect(readInSetup).toBe(channel);
    expect(proc.connection).toBe(channel);
    await proc.stop();
  });

  it("is null for a process nobody gave one", async () => {
    let readInSetup: FrameChannel | null | "never read" = "never read";
    const Holder = holder((connection) => {
      readInSetup = connection;
    });

    const proc = await Holder.spawn({});

    expect(readInSetup).toBe(null);
    expect(proc.connection).toBe(null);
    await proc.stop();
  });

  it("is taken by a process that opens one for itself", async () => {
    const channel = fakeChannel();
    let readAfterOpening: FrameChannel | null = null;
    const Opener = defineActor({
      name: "opener",
      handlers: {},
      setup() {
        this.ctx.connection = channel;
        readAfterOpening = this.ctx.connection;
        return {};
      },
    });

    const proc = await Opener.spawn({});

    expect(readAfterOpening).toBe(channel);
    expect(proc.connection).toBe(channel);
    await proc.stop();
  });
});
