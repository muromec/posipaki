// ── WebSocket integration: real Bun.serve + WHATWG WebSocket client ────────────

import { describe, it, expect, afterEach } from "vitest";
import { defineActor, defineMessages } from "../index.js";
import { serveRemoteActor } from "./reactor.js";
import { remoteClient } from "./client.js";
import { wsServerSpawner, bunServerWebSocket, type BunServerWebSocketLike } from "./spawners/ws-server.js";
import { wsClientSpawner } from "./spawners/ws-client.js";
import { errorReason, isError } from "./channel.js";
import { rootIdFor } from "./process-ref.js";
import type { WebSocketLike } from "./transports/websocket.js";
import { makeWaiter, sleep } from "../util.js";

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
  it("ends the connection that sent a frame that is not a frame, and serves the next one", async () => {
    // The whole point of the guard, on a real socket: a peer sends something that is not a frame,
    // and the cost of it is that one connection.  The host process is this test process — a crash
    // here would end the run rather than fail a case — and the second connection is the proof that
    // it is still serving.
    const echo = makeEcho();
    const serveFailures: unknown[] = [];
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
          // A failure to serve at all is the caller's, the way a real listener takes it: what must
          // not happen is that the same garbage is both a failed start and an unhandled rejection.
          void serveRemoteActor(echo, wsServerSpawner(adapter)).catch((error: unknown) => {
            serveFailures.push(error);
          });
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
    const url = `ws://127.0.0.1:${server.port}`;

    // A peer that speaks the protocol far enough to connect, and then says something else.
    const raw = new WebSocket(url);
    const heard: string[] = [];
    const opened = makeWaiter<void>();
    const ended = makeWaiter<void>();
    let closed = false;
    raw.addEventListener("open", () => opened.resolve());
    raw.addEventListener("message", (event) => heard.push(String(event.data)));
    raw.addEventListener("close", () => {
      closed = true;
      ended.resolve();
    });
    await opened.promise;

    // The connection is made in two hops — the handshake, and then the handler that serves it — and
    // a frame that arrives between them is lost rather than fatal, so the line is said until the
    // wire answers it: first `$init`, the way any peer makes a connection, and then the line that
    // is not a frame.  It is the line swat sends, in substance: not JSON, ASCII, nothing of
    // anyone's in it.
    const deadline = Date.now() + 5000;
    let sent = 0;
    while (!closed && Date.now() < deadline) {
      if (sent++ === 0) {
        raw.send(JSON.stringify({ $init: { parentName: "raw", parentIdName: "root" } }));
      }
      raw.send("not-json-1759080000");
      await sleep(5);
    }
    await ended.promise;

    // Told before the wire went, on the wire it can still read: a `$proto` first, as every
    // connection gets, and then the reason this one is over.
    const said = heard.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(said.filter(isError)).toHaveLength(1);
    expect(errorReason(said.find(isError)!)).toBeTruthy();
    // And it was the connection's frame that failed, not the connection that failed to start: the
    // serving call was never told anything, because there was nothing to tell it.
    expect(serveFailures).toEqual([]);

    // Nothing else happened: the next connection is served as if the last one had never been.
    const proxy = remoteClient<{ start?: number }, { pings: number }, ProxyIn, EchoOut>(
      "echo",
      wsClientSpawner(url),
    );
    const proc = await proxy.spawn({ start: 0 });
    const received: EchoOut[] = [];
    const got = makeWaiter<EchoOut[]>();
    proc.subscribe("message", (msg) => {
      received.push(msg as EchoOut);
      if (received.length === 1) got.resolve(received);
    });

    proc.send({ type: "PING", count: 9 });
    expect(await got.promise).toEqual([{ type: "PONG", count: 9 }]);

    proc.send({ type: "STOP" });
    await proc.wait();
  }, 15000);
});
