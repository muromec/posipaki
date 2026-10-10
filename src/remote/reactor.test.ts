// ── the server reactor ─────────────────────────────────────────────────────
//
// A fake listener and a fake transport, so the loop can be driven by hand: the reactor's own behaviour is
// what is under test here, not a medium's.

import { describe, expect, it } from "vitest";

import { defineActor, defineMessages } from "../index.js";
import { isMsg, isProto, isState } from "./channel.js";
import type { StringTransport } from "./channel.js";
import { rootIdFor } from "./process-ref.js";
import { reactor, type Connection, type Listener, type Session } from "./reactor.js";
import { sleep } from "../util.js";

/** A transport the test drives: what the reactor writes is recorded, what the test writes is delivered. */
class FakeTransport implements StringTransport {
  readonly sent: string[] = [];
  private handler: ((line: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(frame: string): void {
    this.sent.push(frame);
  }
  onMessage(handler: (line: string) => void): void {
    this.handler = handler;
  }
  removeHandler(): void {
    this.handler = null;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  async close(): Promise<void> {
    this.closeHandler?.();
  }

  /** What the reactor wrote, as frames. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  /** A frame from the far side. */
  receive(frame: Record<string, unknown>): void {
    this.handler?.(JSON.stringify(frame));
  }
}

/** A listener a test feeds by hand.  A pending accept is released by `close()`, as the contract says. */
class QueueListener<Meta> implements Listener<Meta> {
  private queue: Connection<Meta>[] = [];
  private waiting: { resolve: (connection: Connection<Meta>) => void; reject: (error: Error) => void } | null =
    null;
  closed = false;

  accept(): Promise<Connection<Meta>> {
    const next = this.queue.shift();
    if (next) return Promise.resolve(next);
    if (this.closed) return Promise.reject(new Error("listener closed"));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(new Error("listener closed"));
  }
  offer(connection: Connection<Meta>): void {
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) waiting.resolve(connection);
    else this.queue.push(connection);
  }
}

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(1);
  }
}

/** The id this side gives its own root: what a frame about it is addressed with. */
const ROOT = rootIdFor("even");

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

/** A connection the test has already admitted, and the frames the far side would send. */
async function connected(transport: FakeTransport, transportName = "echo"): Promise<void> {
  await waitUntil(() => transport.frames().some(isProto), "the $proto frame");
  transport.receive({ $init: { rootName: transportName, parentName: "root", parentIdName: "root" } });
}

describe("reactor", () => {
  it("serves one actor per connection and reports the process", async () => {
    const listener = new QueueListener<{ who: string }>();
    const sessions: Session<{ who: string }>[] = [];
    const closed: Session<{ who: string }>[] = [];
    const r = reactor(listener, makeEcho(), {
      onSession: (session) => sessions.push(session),
      onClosed: (session) => closed.push(session),
    });

    const transport = new FakeTransport();
    listener.offer({ meta: { who: "first" }, transport });
    await connected(transport);

    await waitUntil(() => sessions.length === 1, "the session report");
    expect(sessions[0]!.meta).toEqual({ who: "first" });
    expect(sessions[0]!.proc.pname).toBe("echo");
    expect(r.live).toBe(1);

    transport.receive({ to: ROOT, $tune: { streams: ["message", "state"] } });
    await waitUntil(() => transport.frames().some(isState), "the initial state");
    transport.receive({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 1 } } });
    await waitUntil(() => transport.frames().some(isMsg), "the reply");
    expect(transport.frames().find(isMsg)!.$msg).toMatchObject({ body: { type: "PONG", count: 1 } });

    await transport.close();
    await waitUntil(() => closed.length === 1, "the close report");
    expect(r.live).toBe(0);

    await r.stop();
    expect(listener.closed).toBe(true);
  });

  it("reports the meta the factory added, not the listener's", async () => {
    const listener = new QueueListener<{ who: string }>();
    const sessions: Session<{ who: string }>[] = [];
    const r = reactor(listener, () => ({ actor: makeEcho(), meta: { who: "from the factory" } }), {
      onSession: (session) => sessions.push(session),
    });

    const transport = new FakeTransport();
    listener.offer({ meta: { who: "from the listener" }, transport });
    await connected(transport);

    await waitUntil(() => sessions.length === 1, "the session report");
    expect(sessions[0]!.meta).toEqual({ who: "from the factory" });
    await r.stop();
  });

  it("gives every frame to the hook, and a swallowed one never reaches the actor", async () => {
    const listener = new QueueListener<Record<string, never>>();
    const seen: Record<string, unknown>[] = [];
    const r = reactor(listener, makeEcho(), {
      onIncomingFrame: (frame) => {
        seen.push(frame);
        const body = (frame.$msg as { body?: { count?: number } } | undefined)?.body;
        return body?.count === 1;
      },
    });

    const transport = new FakeTransport();
    listener.offer({ meta: {}, transport });
    await connected(transport);
    await waitUntil(() => transport.frames().some(isProto), "the handshake first");
    transport.receive({ to: ROOT, $tune: { streams: ["message"] } });

    transport.receive({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 1 } } });
    transport.receive({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 2 } } });

    // The second one is the witness: the first was swallowed, so only one reply is ever written.
    await waitUntil(() => transport.frames().filter(isMsg).length >= 1, "the reply to the second");
    await sleep(20);
    expect(transport.frames().filter(isMsg)).toHaveLength(1);
    expect(seen.some((frame) => "$msg" in frame)).toBe(true);

    await r.stop();
  });

  it("stop closes the listener and stops the sessions it is serving", async () => {
    const listener = new QueueListener<Record<string, never>>();
    const sessions: Session<Record<string, never>>[] = [];
    const r = reactor(listener, makeEcho(), {
      onSession: (session) => sessions.push(session),
    });

    const transport = new FakeTransport();
    listener.offer({ meta: {}, transport });
    await connected(transport);
    await waitUntil(() => sessions.length === 1, "the session report");

    await r.stop();

    expect(listener.closed).toBe(true);
    expect(r.live).toBe(0);
    await expect(sessions[0]!.done).resolves.toBeUndefined();
    // The served process is stopped: waiting on it resolves rather than hanging.
    await sessions[0]!.proc.wait();
  });

  it("a connection it cannot serve is reported and does not stop the loop", async () => {
    const listener = new QueueListener<Record<string, never>>();
    const errors: unknown[] = [];
    const sessions: Session<Record<string, never>>[] = [];
    const r = reactor(listener, makeEcho(), {
      onError: (error) => errors.push(error),
      onSession: (session) => sessions.push(session),
    });

    // A far side that never says $init: the serve fails, and the reactor is still accepting.
    const mute = new FakeTransport();
    listener.offer({ meta: {}, transport: mute });
    await waitUntil(() => mute.frames().some(isProto), "the handshake it never answers");
    await mute.close();
    await waitUntil(() => errors.length === 1, "the failure report");

    const transport = new FakeTransport();
    listener.offer({ meta: {}, transport });
    await connected(transport);
    await waitUntil(() => sessions.length === 1, "the second session");

    await r.stop();
  });
});
