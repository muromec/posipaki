// ── WebSocket integration: real Bun.serve + WHATWG WebSocket client ────────────

import { describe, it, expect, afterEach } from "vitest";
import { defineActor, defineMessages } from "../index.js";
import { serveRemoteActor } from "./server.js";
import { remoteClient } from "./client.js";
import { wsServerSpawner, bunServerWebSocket, type BunServerWebSocketLike } from "./spawners/ws-server.js";
import { wsClientSpawner } from "./spawners/ws-client.js";
import type { WebSocketLike } from "./transports/websocket.js";
import { makeWaiter } from "../util.js";

type EchoIn = { type: "PING"; count: number };
type ProxyIn = EchoIn | { type: "STOP" };
type EchoOut = { type: "PONG"; count: number };

function makeEcho() {
  return defineActor({
    name: "echo",
    inMessages: defineMessages<EchoIn>(),
    outMessages: defineMessages<EchoOut>(),
    setup: () => ({ pings: 0 }),
    handlers: {
      async PING(msg: EchoIn) {
        this.state.pings += 1;
        await this.emit({ type: "PONG", count: msg.count });
      },
    },
  });
}

interface ServeResult {
  port: number;
  stop(force?: boolean): void;
}
interface ServeOptions {
  port: number;
  fetch(req: unknown, server: { upgrade(req: unknown): boolean }): Response | undefined;
  websocket: {
    open(ws: BunServerWebSocketLike): void;
    message(ws: BunServerWebSocketLike, message: string): void;
    close(ws: BunServerWebSocketLike): void;
  };
}
const BunRt = (globalThis as unknown as { Bun: { serve(opts: ServeOptions): ServeResult } }).Bun;

const servers: ServeResult[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

describe("WebSocket remote actors", () => {
  it("full round-trip: PING → PONG → STOP", async () => {
    const echo = makeEcho();
    const server = BunRt.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(ws) {
          const adapter = bunServerWebSocket(ws);
          ws.data = adapter;
          void serveRemoteActor(echo, wsServerSpawner(adapter));
        },
        message(ws, msg) {
          (ws.data as WebSocketLike).onmessage?.({ data: msg });
        },
        close(ws) {
          (ws.data as WebSocketLike).onclose?.();
        },
      },
    });
    servers.push(server);

    const proxy = remoteClient<{ start?: number }, { pings: number }, ProxyIn, EchoOut>(
      "echo",
      wsClientSpawner(`ws://127.0.0.1:${server.port}`),
    );
    const proc = await proxy.spawn({ start: 0 });
    await proc.ready();

    const received: EchoOut[] = [];
    const got = makeWaiter<EchoOut[]>();
    proc.subscribe("message", (msg) => {
      received.push(msg as EchoOut);
      if (received.length === 1) got.resolve(received);
    });

    proc.send({ type: "PING", count: 1 });
    expect(await got.promise).toEqual([{ type: "PONG", count: 1 }]);

    proc.send({ type: "STOP" });
    await proc.wait();
  }, 15000);
});
