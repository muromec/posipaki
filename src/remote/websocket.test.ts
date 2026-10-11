// ── the websocket listener: an HTTP server's upgrades ───────────────────────
//
// A fake server that reports an upgrade when the test says one arrived, and a fake socket for each.
// What is under test is the accept loop, admission and refusal; the handshake is the WebSocket
// implementation's step, so here it is the test's own hook.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import { defineActor, defineMessages } from "../index.js";
import { isMsg, isProto, isState } from "./channel.js";
import { rootIdFor } from "./process-ref.js";
import { VERSION } from "./protocols/json1.js";
import { reactor, type Session } from "./reactor.js";
import { webSocketListener, type UpgradeSource } from "./websocket.js";
import type { WebSocketLike } from "./transports/websocket.js";
import { sleep } from "../util.js";

const ROOT = rootIdFor("even");

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
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

/** The socket an upgrade arrived on: what the listener said on it, and what it did with it. */
class FakeSocket {
  destroyed = false;
  /** What was ended on it: a refusal is one line of HTTP, written before any handshake. */
  ended: string[] = [];
  private closeHandlers: Array<() => void> = [];

  end(data?: string): void {
    if (data !== undefined) this.ended.push(data);
    this.destroyed = true;
  }
  destroy(): void {
    this.destroyed = true;
    for (const handler of this.closeHandlers.splice(0)) handler();
  }
  once(event: string, handler: () => void): void {
    if (event === "close") this.closeHandlers.push(handler);
  }
}

/** The socket the handshake would answer with: what the serve wrote, and what the far side sends. */
class FakeSocketLike implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** A frame from the far side. */
  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

/** An HTTP server that reports an upgrade when the test says one arrived. */
class FakeServer implements UpgradeSource {
  private handler: ((request: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;

  on(event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): this {
    if (event === "upgrade") this.handler = listener;
    return this;
  }
  off(event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): this {
    if (event === "upgrade" && this.handler === listener) this.handler = null;
    return this;
  }
  get listening(): boolean {
    return this.handler !== null;
  }
  /** An upgrade arrived on this path. */
  arrive(url: string): FakeSocket {
    const socket = new FakeSocket();
    this.handler?.(
      { url, headers: { host: "127.0.0.1" } } as unknown as IncomingMessage,
      socket as unknown as Duplex,
      Buffer.alloc(0),
    );
    return socket;
  }
}

describe("webSocketListener", () => {
  it("admits an upgrade and serves the process the reactor spawns over it", async () => {
    const server = new FakeServer();
    const answered: FakeSocketLike[] = [];
    const listener = webSocketListener<{ who: string }>({
      server,
      path: "/ws",
      identify: (upgrade) => ({ who: upgrade.url.pathname }),
      upgrade: async () => {
        const socket = new FakeSocketLike();
        answered.push(socket);
        return socket;
      },
    });

    const sessions: Session<{ who: string }>[] = [];
    const r = reactor(listener, makeEcho(), { onSession: (session) => void sessions.push(session) });

    server.arrive("/ws?token=abc");
    await waitUntil(() => answered.length === 1, "the handshake");
    const socket = answered[0]!;
    await waitUntil(() => socket.frames().some(isProto), "the $proto frame");
    expect(socket.frames().find(isProto)!.$proto).toBe(VERSION);

    socket.receive({ $init: { rootName: "echo", parentName: "root", parentIdName: "root" } });
    await waitUntil(() => sessions.length === 1, "the session report");
    expect(sessions[0]!.meta).toEqual({ who: "/ws" });
    expect(sessions[0]!.proc.pname).toBe("echo");

    socket.receive({ to: ROOT, $tune: { streams: ["state", "message"] } });
    await waitUntil(() => socket.frames().some(isState), "the initial state");
    socket.receive({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 3 } } });
    await waitUntil(() => socket.frames().some(isMsg), "the reply");
    expect(socket.frames().find(isMsg)!.$msg).toMatchObject({ body: { type: "PONG", count: 3 } });

    await r.stop();
    expect(server.listening).toBe(false);
  });

  it("refuses an upgrade admission does not accept, before any handshake", async () => {
    const server = new FakeServer();
    let handshakes = 0;
    const listener = webSocketListener({
      server,
      identify: () => {
        throw new Error("the token was not accepted");
      },
      upgrade: async () => {
        handshakes += 1;
        return new FakeSocketLike();
      },
    });
    const errors: unknown[] = [];
    const r = reactor(listener, makeEcho(), { onError: (error) => errors.push(error) });

    const socket = server.arrive("/ws");
    await waitUntil(() => socket.ended.length > 0, "the refusal");

    expect(socket.ended[0]).toContain("401");
    expect(handshakes).toBe(0);
    expect(socket.destroyed).toBe(true);
    // A refused connection costs no actor, and no error either: it was never a connection.
    expect(r.live).toBe(0);
    expect(errors).toEqual([]);
    await r.stop();
  });

  it("takes a refusal the consumer shapes itself", async () => {
    const server = new FakeServer();
    const refusals: Array<{ error: unknown; path: string }> = [];
    const listener = webSocketListener({
      server,
      identify: () => {
        throw new Error("no");
      },
      upgrade: async () => new FakeSocketLike(),
      refuse: (socket, error, upgrade) => {
        refusals.push({ error, path: upgrade.url.pathname });
        socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n`);
      },
    });

    const socket = server.arrive("/ws");
    await waitUntil(() => socket.ended.length > 0, "the refusal");
    expect(socket.ended[0]).toContain("403");
    expect((refusals[0]!.error as Error).message).toBe("no");
    expect(refusals[0]!.path).toBe("/ws");
    await listener.close();
  });

  it("leaves an upgrade on another path as it arrived", async () => {
    const server = new FakeServer();
    let handshakes = 0;
    const listener = webSocketListener({
      server,
      path: "/ws",
      upgrade: async () => {
        handshakes += 1;
        return new FakeSocketLike();
      },
    });

    const socket = server.arrive("/other");
    const pending = listener.accept().then(
      () => "taken",
      (error: Error) => error.message,
    );
    const settled = await Promise.race([pending, sleep(20).then(() => "still waiting" as const)]);

    // Nobody wrote on it and nobody closed it: another listener, or the server's own handler, can
    // still answer this one.
    expect(settled).toBe("still waiting");
    expect(socket.ended).toEqual([]);
    expect(socket.destroyed).toBe(false);
    expect(handshakes).toBe(0);

    await listener.close();
    expect(await pending).toMatch(/closed/);
  });

  it("releases an accept that is still waiting when it is closed", async () => {
    const server = new FakeServer();
    const listener = webSocketListener({ server, upgrade: async () => new FakeSocketLike() });

    const pending = listener.accept().then(
      () => "arrived",
      (error: Error) => error.message,
    );
    await listener.close();

    expect(await pending).toMatch(/closed/);
  });

  it("drops the upgrades it is holding when it is closed", async () => {
    const server = new FakeServer();
    let admitted = 0;
    const listener = webSocketListener({
      server,
      identify: () => {
        admitted += 1;
      },
      upgrade: async () => new FakeSocketLike(),
    });

    const socket = server.arrive("/ws");
    await waitUntil(() => admitted === 1, "admission");
    await listener.close();

    expect(socket.destroyed).toBe(true);
    await expect(listener.accept()).rejects.toThrow(/closed/);
  });
});
