// ── remoteClient unit tests (in-memory fake channel) ───────────────────────

import { describe, it, expect } from "vitest";
import { remoteClient } from "./client.js";
import { isInit, isMsg } from "./channel.js";
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

type CounterIn = { type: "INCREMENT"; by: number } | { type: "STOP" };
type CounterOut = { type: "COUNT_CHANGED"; count: number };

describe("remoteClient (unit)", () => {
  it("returns an actor that bridges to the server", async () => {
    const channel = new FakeChannel();
    const actor = remoteClient<{ start: number }, { count: number }, CounterIn, CounterOut>(
      "counter",
      () => Promise.resolve(channel),
    );

    const proc = await actor.spawn({ start: 0 });

    while (!channel.sent.some(isInit)) await sleep(1);
    expect(channel.sent.find(isInit)!.$init).toMatchObject({
      parentName: "counter",
      parentIdName: "counter",
    });

    while (!channel.handler) await sleep(1);
    channel.handler!({ $state: { count: 0 } });
    while (proc.state?.count !== 0) await sleep(1);

    const received: CounterOut[] = [];
    proc.subscribe("message", (msg) => received.push(msg as CounterOut));
    channel.handler!({ $msg: { fromName: "server", body: { type: "COUNT_CHANGED", count: 1 } } });
    while (received.length !== 1) await sleep(1);
    expect(received[0]).toEqual({ type: "COUNT_CHANGED", count: 1 });

    proc.send({ type: "INCREMENT", by: 2 });
    while (!channel.sent.some(isMsg)) await sleep(1);
    expect(channel.sent.find(isMsg)!.$msg).toMatchObject({
      fromName: "counter",
      body: { type: "INCREMENT", by: 2 },
    });

    proc.send({ type: "STOP" });
    while (
      !channel.sent.some(
        (f) => isMsg(f) && (f as { $msg: { body: { type: string } } }).$msg.body.type === "STOP",
      )
    ) {
      await sleep(1);
    }
    channel.handler!({ $exit: { code: 0, state: { count: 1 } } });
    await proc.wait();
  });

  it("closes the channel when the proxy stops", async () => {
    const channel = new FakeChannel();
    const actor = remoteClient<{ start: number }, { count: number }, CounterIn, CounterOut>(
      "counter",
      () => Promise.resolve(channel),
    );

    const proc = await actor.spawn({ start: 0 });
    while (!channel.handler) await sleep(1);
    channel.handler!({ $state: { count: 0 } });

    proc.send({ type: "STOP" });
    while (!channel.sent.some((f) => isMsg(f))) await sleep(1);
    channel.handler!({ $exit: { code: 0, state: { count: 0 } } });
    await proc.wait();

    expect(channel.closed).toBe(true);
  });
});
