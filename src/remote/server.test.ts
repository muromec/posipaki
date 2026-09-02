// ── serveRemoteActor unit tests (in-memory fake channel) ───────────────────

import { describe, it, expect } from "vitest";
import { defineActor, defineMessages } from "../index.js";
import { serveRemoteActor } from "./server.js";
import { isState, isMsg, isExit } from "./channel.js";
import type { Channel } from "./channel.js";
import { sleep } from "../util.js";

class FakeChannel implements Channel {
  sent: Record<string, unknown>[] = [];
  handler: ((frame: Record<string, unknown>) => void) | null = null;
  closeHandler: (() => void) | null = null;
  closed = false;

  async send(frame: Record<string, unknown>) {
    this.sent.push(frame);
  }
  onMessage(handler: (frame: Record<string, unknown>) => void) {
    if (this.handler) throw new Error("handler already set");
    this.handler = handler;
  }
  removeHandler() {
    this.handler = null;
  }
  onClose(handler: () => void) {
    this.closeHandler = handler;
  }
  async close() {
    this.closed = true;
  }
}

async function waitUntil(predicate: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(1);
  }
}

function makeEcho() {
  return defineActor({
    name: "echo",
    inMessages: defineMessages<{ type: "PING"; count: number }>(),
    outMessages: defineMessages<{ type: "PONG"; count: number }>(),
    setup: () => ({ pings: 0 }),
    handlers: {
      async PING(msg: { type: "PING"; count: number }) {
        this.state.pings += 1;
        await this.emit({ type: "PONG", count: msg.count });
      },
    },
  });
}

describe("serveRemoteActor (unit)", () => {
  it("handshakes, bridges messages and state, and announces exit", async () => {
    const channel = new FakeChannel();
    const serve = serveRemoteActor(makeEcho(), () => Promise.resolve(channel));

    // 1. awaits $init
    await waitUntil(() => channel.handler !== null, "$init handler");
    channel.handler!({ $init: { parentName: "root", parentIdName: "root" } });

    // 2. emits initial $state
    await waitUntil(() => channel.sent.some(isState), "initial $state");
    expect(channel.sent.find(isState)!.$state).toEqual({ pings: 0 });

    // 3. forwards $msg → actor → $msg out
    await waitUntil(() => channel.handler !== null, "message handler");
    channel.handler!({ $msg: { fromName: "root", body: { type: "PING", count: 2 } } });
    await waitUntil(() => channel.sent.some(isMsg), "$msg reply");
    expect(channel.sent.find(isMsg)!.$msg).toMatchObject({
      fromName: "remote",
      body: { type: "PONG", count: 2 },
    });

    // 4. STOP → $exit + close
    channel.handler!({ $msg: { fromName: "root", body: { type: "STOP" } } });
    await waitUntil(() => channel.sent.some(isExit), "$exit");

    await serve;
    expect(channel.closed).toBe(true);
    expect(channel.sent.find(isExit)!.$exit.code).toBe(0);
  });

  it("does not emit initial $state before $init", async () => {
    const channel = new FakeChannel();
    const serve = serveRemoteActor(makeEcho(), () => Promise.resolve(channel));

    await waitUntil(() => channel.handler !== null, "$init handler");
    expect(channel.sent.filter(isState)).toEqual([]);

    channel.handler!({ $init: { parentName: "root", parentIdName: "root" } });
    await waitUntil(() => channel.sent.some(isState), "initial $state");
    await waitUntil(() => channel.handler !== null, "message handler");
    channel.handler!({ $msg: { fromName: "root", body: { type: "STOP" } } });
    await serve;
  });
});
