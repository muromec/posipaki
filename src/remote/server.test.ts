// ── serveRemoteActor unit tests (in-memory fake transport) ────────────────
//
// These exercise the transport-agnostic serve loop without spawning a process
// or touching a fifo. The FIFO end-to-end path is covered separately in
// server.integration.test.ts.

import { describe, it, expect } from "vitest";
import { defineActor, defineMessages } from "../index.js";
import { serveRemoteActor } from "./server.js";
import { encode, decode, isProto, isState, isMsg, isExit, PROTO_VERSION } from "./protocol.js";
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

const sentFrames = (t: FakeTransport) => t.sent.map(decode);

describe("serveRemoteActor (unit)", () => {
  it("handshakes, bridges messages and state, and announces exit", async () => {
    const transport = new FakeTransport();
    const serve = serveRemoteActor(makeEcho().fn, transport);

    // 1. announces protocol version first
    await waitUntil(() => transport.sent.length >= 1, "$proto");
    expect(decode(transport.sent[0])).toEqual({ $proto: PROTO_VERSION });

    // 2. waits for $init, then spawns
    await waitUntil(() => transport.handler !== null, "$init handler");
    transport.handler!(encode("$init", { parentName: "root", parentIdName: "root" }));

    // 3. emits initial $state
    await waitUntil(() => sentFrames(transport).some(isState), "initial $state");
    const initial = sentFrames(transport).find(isState)!;
    expect(initial.$state).toEqual({ pings: 0 });

    // 4. bridges $msg in → actor → $msg out + mirrored state
    await waitUntil(() => transport.handler !== null, "message handler");
    transport.handler!(encode("$msg", { fromName: "root", body: { type: "PING", count: 2 } }));

    await waitUntil(() => sentFrames(transport).some(isMsg), "$msg reply");
    const pong = sentFrames(transport).find(isMsg)!;
    expect(pong.$msg).toMatchObject({ fromName: "remote", body: { type: "PONG", count: 2 } });

    await waitUntil(
      () =>
        sentFrames(transport).some(
          (f) => isState(f) && f.$state.pings === 1,
        ),
      "mirrored state",
    );

    // 5. STOP → $exit + close
    transport.handler!(encode("$msg", { fromName: "root", body: { type: "STOP" } }));
    await waitUntil(() => sentFrames(transport).some(isExit), "$exit");

    await serve;
    expect(transport.closed).toBe(true);

    const exit = sentFrames(transport).find(isExit)!;
    expect(exit.$exit.code).toBe(0);
  });

  it("does not emit the initial $state before $init", async () => {
    const transport = new FakeTransport();
    const serve = serveRemoteActor(makeEcho().fn, transport);

    await waitUntil(() => transport.sent.length >= 1, "$proto");
    // no $init yet — the serve loop must be blocked waiting for it
    expect(sentFrames(transport).filter(isState)).toEqual([]);

    // release it so the test tears down cleanly
    await waitUntil(() => transport.handler !== null, "$init handler");
    transport.handler!(encode("$init", { parentName: "root", parentIdName: "root" }));
    await waitUntil(() => sentFrames(transport).some(isState), "initial $state");
    transport.handler!(encode("$msg", { fromName: "root", body: { type: "STOP" } }));
    await serve;
  });
});
