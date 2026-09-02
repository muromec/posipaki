// ── connectRemote unit tests (in-memory fake transport) ────────────────────
//
// These exercise the transport-agnostic client handshake and pump without
// spawning a process or touching a fifo. The FIFO spawn + handshake path is
// covered separately in client.integration.test.ts.

import { describe, it, expect } from "vitest";
import { connectRemote } from "./client.js";
import { encode, decode, isInit, isState, isMsg, isExit, PROTO_VERSION } from "./protocol.js";
import { sleep } from "../util.js";
import type { Transport } from "./transport.js";

class FakeTransport implements Transport {
  sent: string[] = [];
  handler: ((frame: string) => void) | null = null;
  closed = false;

  async send(frame: string) {
    this.sent.push(frame);
  }
  onMessage(handler: (frame: string) => void) {
    if (this.handler) throw new Error("handler already set");
    this.handler = handler;
  }
  removeHandler() {
    this.handler = null;
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

const sentFrames = (t: FakeTransport) => t.sent.map(decode);

describe("connectRemote (unit)", () => {
  it("handshakes, sends $init, pumps state/messages, and resolves on $exit", async () => {
    const transport = new FakeTransport();
    const proxyPromise = connectRemote<{ pings: number }>(transport, {
      args: {},
      parentName: "root",
    });

    // 1. awaits $proto from the server
    await waitUntil(() => transport.handler !== null, "$proto handler");
    transport.handler!(encode("$proto", PROTO_VERSION));

    // 2. sends $init with domain args + parent identity
    await waitUntil(() => sentFrames(transport).some(isInit), "$init");
    const init = sentFrames(transport).find(isInit)!;
    expect(init.$init).toMatchObject({ parentName: "root", parentIdName: "root" });

    // 3. awaits the first $state (the ready signal)
    await waitUntil(() => transport.handler !== null, "$state handler");
    transport.handler!(encode("$state", { pings: 0 }));

    const proxy = await proxyPromise;
    expect(proxy.state).toEqual({ pings: 0 });

    // 4. pumps $state updates into the proxy's state
    transport.handler!(encode("$state", { pings: 1 }));
    await waitUntil(() => proxy.state.pings === 1, "state update");

    // 5. delivers $msg to the registered handler
    const received: unknown[] = [];
    proxy.onMessage((msg) => received.push(msg));
    transport.handler!(encode("$msg", { fromName: "server", body: { type: "PONG", count: 42 } }));
    await waitUntil(() => received.length === 1, "$msg delivery");
    expect(received[0]).toEqual({ type: "PONG", count: 42 });

    // 6. resolves wait() on $exit
    transport.handler!(encode("$exit", { code: 0, state: { pings: 1 } }));
    const exit = await proxy.wait();
    expect(exit).toEqual({ code: 0, state: { pings: 1 } });
  });

  it("rejects an unsupported protocol version", async () => {
    const transport = new FakeTransport();
    const proxyPromise = connectRemote(transport, { args: {} });

    await waitUntil(() => transport.handler !== null, "$proto handler");
    transport.handler!(encode("$proto", "nope.v1"));

    await expect(proxyPromise).rejects.toThrow(/unsupported protocol/);
  });

  it("exposes send() that frames a $msg with the client identity", async () => {
    const transport = new FakeTransport();
    const proxyPromise = connectRemote<{ pings: number }, { type: string; count: number }>(
      transport,
      { args: {}, parentName: "root" },
    );

    await waitUntil(() => transport.handler !== null, "$proto handler");
    transport.handler!(encode("$proto", PROTO_VERSION));
    await waitUntil(() => sentFrames(transport).some(isInit), "$init");
    await waitUntil(() => transport.handler !== null, "$state handler");
    transport.handler!(encode("$state", { pings: 0 }));

    const proxy = await proxyPromise;
    proxy.send({ type: "PING", count: 7 });

    await waitUntil(() => sentFrames(transport).some(isMsg), "$msg out");
    const msg = sentFrames(transport).find(isMsg)!;
    expect(msg.$msg).toMatchObject({ fromName: "root", body: { type: "PING", count: 7 } });
  });
});
