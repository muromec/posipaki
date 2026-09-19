// ── remoteClient unit tests (in-memory fake channel) ───────────────────────

import { describe, it, expect } from "vitest";
import { remoteClient } from "./client.js";
import { frameTo, isInit, isMsg, isStop } from "./channel.js";
import type { Channel } from "./channel.js";
import { rootIdFor } from "./process-ref.js";
import { sleep } from "../util.js";

/** The id the server's root goes by: what every frame about it is addressed with, and
 *  what this side asks of it. */
const SERVER_ROOT = rootIdFor("even");

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

    // awaitReady: false — this proxy's setup() waits for the server's first
    // $state frame, which only arrives after spawn() has returned.
    const proc = await actor.spawn({ start: 0 }, { awaitReady: false });

    while (!channel.sent.some(isInit)) await sleep(1);
    expect(channel.sent.find(isInit)!.$init).toMatchObject({
      // The names are the full ones this side knows the processes by, not the short name the
      // definition was written with: the far side is serving this side's own end of the
      // connection, and spells its subtree off what it is told here.
      rootName: "counter",
      parentName: "counter",
      parentIdName: "counter",
    });

    while (!channel.handler) await sleep(1);
    channel.handler!({ to: SERVER_ROOT, $state: { count: 0 } });
    while (proc.state?.count !== 0) await sleep(1);

    const received: CounterOut[] = [];
    proc.subscribe("message", (msg) => received.push(msg as CounterOut));
    channel.handler!({ to: SERVER_ROOT, $msg: { fromName: "server", body: { type: "COUNT_CHANGED", count: 1 } } });
    while (received.length !== 1) await sleep(1);
    expect(received[0]).toEqual({ type: "COUNT_CHANGED", count: 1 });

    proc.send({ type: "INCREMENT", by: 2 });
    while (!channel.sent.some(isMsg)) await sleep(1);
    expect(channel.sent.find(isMsg)!.$msg).toMatchObject({
      fromName: "counter",
      body: { type: "INCREMENT", by: 2 },
    });

    proc.send({ type: "STOP" });
    // A stop request is a request to the process the proxy stands for, so it goes out
    // as the control frame every handle uses, addressed to the far root.
    while (!channel.sent.some((f) => frameTo(f) === SERVER_ROOT && isStop(f))) await sleep(1);
    channel.handler!({ to: SERVER_ROOT, $exit: { code: 0, state: { count: 1 } } });
    await proc.wait();
  });

  it("rejects the spawn when the spawner fails", async () => {
    const failure = new Error("no environment for you");
    const actor = remoteClient<{ start: number }, { count: number }, CounterIn, CounterOut>(
      "counter",
      () => Promise.reject(failure),
    );

    // The spawner's failure is the caller's business, and it is the only thing
    // that can explain it: spawn() has to reject with that error.  Today the
    // process never settles — setup() threw, so no state ever arrived, and the
    // end-of-life hooks then run against that missing state instead.
    await expect(
      Promise.race([
        actor.spawn({ start: 0 }, {}),
        sleep(2_000).then(() => {
          throw new Error("spawn neither resolved nor rejected");
        }),
      ]),
    ).rejects.toThrow("no environment for you");
  });

  it("notifies state subscribers when a $state frame arrives", async () => {
    const channel = new FakeChannel();
    const actor = remoteClient<{ start: number }, { count: number }, CounterIn, CounterOut>(
      "counter",
      () => Promise.resolve(channel),
    );
    // awaitReady: false — this proxy's setup() waits for the server's first
    // $state frame, which only arrives after spawn() has returned.
    const proc = await actor.spawn({ start: 0 }, { awaitReady: false });
    while (!channel.handler) await sleep(1);
    channel.handler!({ to: SERVER_ROOT, $state: { count: 0 } });
    while (proc.state?.count !== 0) await sleep(1);

    const seen: Array<{ count: number }> = [];
    proc.subscribe("state", () => seen.push(proc.state as { count: number }));

    channel.handler!({ to: SERVER_ROOT, $state: { count: 5 } });
    while (seen.length === 0) await sleep(1);
    expect(seen[0]).toEqual({ count: 5 });
  });

  it("closes the channel when the proxy stops", async () => {
    const channel = new FakeChannel();
    const actor = remoteClient<{ start: number }, { count: number }, CounterIn, CounterOut>(
      "counter",
      () => Promise.resolve(channel),
    );

    // awaitReady: false — this proxy's setup() waits for the server's first
    // $state frame, which only arrives after spawn() has returned.
    const proc = await actor.spawn({ start: 0 }, { awaitReady: false });
    while (!channel.handler) await sleep(1);
    channel.handler!({ to: SERVER_ROOT, $state: { count: 0 } });

    proc.send({ type: "STOP" });
    while (!channel.sent.some(isStop)) await sleep(1);
    channel.handler!({ to: SERVER_ROOT, $exit: { code: 0, state: { count: 0 } } });
    await proc.wait();

    expect(channel.closed).toBe(true);
  });
});
