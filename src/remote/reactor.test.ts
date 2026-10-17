// ── the server reactor ─────────────────────────────────────────────────────
//
// A fake listener and a fake transport, so the loop can be driven by hand: the reactor's own behaviour is
// what is under test here, not a medium's.

import { describe, expect, it } from "vitest";

import { defineActor, defineMessages } from "../index.js";
import { isExit, isMsg, isProto, isState, outputFrame, type Channel, type StringTransport } from "./channel.js";
import { rootIdFor } from "./process-ref.js";
import {
  oneConnection,
  reactor,
  spawnFactory,
  type Connection,
  type Listener,
  type ServedConnection,
  type Session,
} from "./reactor.js";
import { sleep } from "../util.js";
import { nextState } from "../testing/index.js";

/** A transport the test drives: what the reactor writes is recorded, what the test writes is delivered. */
/** A transport the test drives: what the reactor writes is recorded, what the test writes is delivered. */
class FakeTransport implements StringTransport {
  readonly sent: string[] = [];
  readonly sentBytes: Uint8Array[] = [];
  private handler: ((line: string) => number | void) | null = null;
  private bytesHandler: ((bytes: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(frame: string): void {
    this.sent.push(frame);
  }
  sendBytes(bytes: Uint8Array): void {
    this.sentBytes.push(bytes);
  }
  onMessage(handler: (line: string) => number | void): void {
    this.handler = handler;
  }
  onBytes(handler: (bytes: Uint8Array) => void): void {
    this.bytesHandler = handler;
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
  /** The octets the far side sends after a line that announced them. */
  receiveBytes(bytes: Uint8Array): void {
    this.bytesHandler?.(bytes);
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

/** The reactor's own report of a session, as something to await: the event, not a poll for it. */
function nextSession<Meta>(): { reported: Promise<Session<Meta>>; report: (session: Session<Meta>) => void } {
  let report: (session: Session<Meta>) => void = () => {};
  const reported = new Promise<Session<Meta>>((resolve) => {
    report = resolve;
  });
  return { reported, report };
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
      onSession: (session) => void sessions.push(session),
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
    const r = reactor(
      listener,
      async (_connection, init) => ({
        proc: await makeEcho().spawn(init.args, { name: init.rootName }),
        meta: { who: "from the factory" },
      }),
      { onSession: (session) => void sessions.push(session) },
    );

    const transport = new FakeTransport();
    listener.offer({ meta: { who: "from the listener" }, transport });
    await connected(transport);

    await waitUntil(() => sessions.length === 1, "the session report");
    expect(sessions[0]!.meta).toEqual({ who: "from the factory" });
    await r.stop();
  });

  it("carries the far end's own output from the process that is served", async () => {
    // The connection the serve hands the root is the whole way out: a process that prints says so
    // in a frame of its own, and there is no knob on the factory to offer it instead.
    const listener = new QueueListener<{ who: string }>();
    const Writing = defineActor({
      name: "writing",
      handlers: {},
      async setup() {
        await this.ctx.connection?.send(outputFrame(2, "a line of its own"));
        return {};
      },
    });
    const sessions: Session<{ who: string }>[] = [];
    const r = reactor(listener, Writing, { onSession: (session) => void sessions.push(session) });

    const transport = new FakeTransport();
    listener.offer({ meta: { who: "first" }, transport });
    await connected(transport);
    await waitUntil(() => sessions.length === 1, "the session report");

    expect(transport.frames()).toContainEqual({ $fd: 2, data: "a line of its own" });

    await r.stop();
  });

  it("runs the factory's cleanup, and leaves a process it did not spawn running", async () => {
    const listener = new QueueListener<{ who: string }>();
    const closed: Session<{ who: string }>[] = [];
    const sessions: Session<{ who: string }>[] = [];
    const proc = await makeEcho().spawn(undefined, { name: "kept" });
    let ended = false;
    void proc.wait().then(
      () => {
        ended = true;
      },
      () => {
        ended = true;
      },
    );
    let cleaned = 0;
    const r = reactor(
      listener,
      () => ({
        proc,
        cleanup: () => {
          cleaned += 1;
        },
      }),
      {
        onSession: (session) => void sessions.push(session),
        onClosed: (session) => closed.push(session),
      },
    );

    const transport = new FakeTransport();
    listener.offer({ meta: { who: "first" }, transport });
    await connected(transport);
    // The session is reported before the connection goes: that is when the serve is wired to it.
    await waitUntil(() => sessions.length === 1, "the session report");

    // The connection goes: the session ends, and the cleanup the factory answered with is what runs.
    await transport.close();
    await waitUntil(() => closed.length === 1, "the close report");
    expect(cleaned).toBe(1);
    // A process the connection did not own is still up, and only its own stop ends it.
    expect(ended).toBe(false);
    await proc.stop();
    expect(ended).toBe(true);
    await r.stop();
  });

  it("serves one process to more than one connection", async () => {
    const listener = new QueueListener<Record<string, never>>();
    const sessions: Session<Record<string, never>>[] = [];
    const closed: Session<Record<string, never>>[] = [];
    // One process, handed over to each connection: a cleanup of the factory's own is what says it outlives
    // them, since the default would stop it for the others.
    const proc = await makeEcho().spawn(undefined, { name: "shared" });
    let ended = false;
    void proc.wait().then(
      () => {
        ended = true;
      },
      () => {
        ended = true;
      },
    );
    let cleaned = 0;
    const r = reactor(
      listener,
      () => ({
        proc,
        cleanup: () => {
          cleaned += 1;
        },
      }),
      {
        onSession: (session) => void sessions.push(session),
        onClosed: (session) => closed.push(session),
      },
    );

    const first = new FakeTransport();
    listener.offer({ meta: {}, transport: first });
    await connected(first, "shared");
    const second = new FakeTransport();
    listener.offer({ meta: {}, transport: second });
    await connected(second, "shared");
    await waitUntil(() => sessions.length === 2, "both sessions");

    // Each side asks to hear it, the way a proxy asks for the process it stands in for.
    first.receive({ to: ROOT, $tune: { streams: ["message", "state", "exit"] } });
    second.receive({ to: ROOT, $tune: { streams: ["message", "state", "exit"] } });
    await waitUntil(
      () => first.frames().some(isState) && second.frames().some(isState),
      "the state on both connections",
    );

    const pong = (transport: FakeTransport, count: number): boolean =>
      transport.frames().some((frame) => isMsg(frame) && (frame.$msg.body as { count?: number }).count === count);

    // One message in, and the one process answering is heard on both.
    first.receive({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 7 } } });
    await waitUntil(() => pong(first, 7) && pong(second, 7), "the reply on both connections");

    // One client goes: its session ends and its cleanup runs, and the other keeps talking to the same process.
    await first.close();
    await waitUntil(() => closed.length === 1, "the first session to close");
    expect(cleaned).toBe(1);
    expect(ended).toBe(false);
    second.receive({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 8 } } });
    await waitUntil(() => pong(second, 8), "the reply after the first connection went");

    // The process's own end reaches the connection still bound to it, and that session ends with its wire.
    await proc.stop();
    await waitUntil(() => closed.length === 2, "the second session to close");
    expect(second.frames().some(isExit)).toBe(true);
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
      onSession: (session) => void sessions.push(session),
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
      onSession: (session) => void sessions.push(session),
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

  it("hands the session its connection, and runs what onSession returned when it is over", async () => {
    const listener = new QueueListener<{ who: string }>();
    const order: string[] = [];
    const { reported, report } = nextSession<{ who: string }>();
    let heard: (frame: Record<string, unknown>) => void = () => {};
    const sessionHeard = new Promise<Record<string, unknown>>((resolve) => {
      heard = resolve;
    });
    let factoryChannel: Channel | null = null;
    const r = reactor(
      listener,
      (connection, init) => {
        factoryChannel = connection.channel;
        return spawnFactory<{ who: string }>(makeEcho())(connection, init);
      },
      {
        onSession: (session) => {
          report(session);
          // What a starter reads here is the incoming side of the connection, and the serve reads it
          // as well: one channel, two readers.
          session.channel.onMessage((frame) => {
            if (isMsg(frame)) heard(frame);
          });
          return async () => {
            // A microtask, so a cleanup that gets called is told from one that gets awaited.
            await Promise.resolve();
            order.push("released");
          };
        },
        onClosed: () => order.push("closed"),
      },
    );

    const transport = new FakeTransport();
    listener.offer({ meta: { who: "first" }, transport });
    await connected(transport);
    const session = await reported;

    expect(session.channel).toBe(factoryChannel);

    // Both frames in one turn, so a single tick covers them: the far side asks for the root's
    // streams, and then sends it a message.
    const tick = nextState(session.proc);
    transport.receive({ to: ROOT, $tune: { streams: ["message", "state"] } });
    transport.receive({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 4 } } });
    await expect(sessionHeard).resolves.toMatchObject({
      to: ROOT,
      $msg: { fromName: "root", body: { type: "PING", count: 4 } },
    });
    await tick;
    // And the answer is on the wire: the serve handled the frame the session's reader also heard.
    expect(transport.frames().find(isMsg)!.$msg).toMatchObject({ body: { type: "PONG", count: 4 } });

    await transport.close();
    await session.done;
    expect(order).toEqual(["released", "closed"]);

    await r.stop();
  });

  it("reports a cleanup that throws, and closes the session anyway", async () => {
    const listener = new QueueListener<{ who: string }>();
    const errors: unknown[] = [];
    const closed: Session<{ who: string }>[] = [];
    const { reported, report } = nextSession<{ who: string }>();
    const r = reactor(listener, makeEcho(), {
      onSession: (session) => {
        report(session);
        return () => {
          throw new Error("the reader would not go");
        };
      },
      onClosed: (session) => void closed.push(session),
      onError: (error) => errors.push(error),
    });

    const transport = new FakeTransport();
    listener.offer({ meta: { who: "first" }, transport });
    await connected(transport);
    const session = await reported;

    await transport.close();
    // The report settles either way: a cleanup that throws is news, not a session left hanging.
    await session.done;
    expect((errors[0] as Error).message).toBe("the reader would not go");
    expect(closed).toHaveLength(1);

    await r.stop();
  });
});

/** A channel the test holds both ends of: what the serve writes is recorded, what it reads is delivered. */
class FakeChannel implements Channel {
  readonly sent: Record<string, unknown>[] = [];
  private handler: ((frame: Record<string, unknown>) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(frame: Record<string, unknown>): void {
    this.sent.push(frame);
  }
  onMessage(handler: (frame: Record<string, unknown>) => void): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  async close(): Promise<void> {
    this.closeHandler?.();
  }
  /** Whether the serve has set its handler: the moment a frame from the far side would be heard. */
  get listening(): boolean {
    return this.handler !== null;
  }
  receive(frame: Record<string, unknown>): void {
    this.handler?.(frame);
  }
}

describe("oneConnection", () => {
  it("serves over a channel somebody else opened, and takes it once", async () => {
    const channel = new FakeChannel();
    const listener = oneConnection<Record<string, never>>(() => Promise.resolve(channel));
    const sessions: Session<Record<string, never>>[] = [];
    const r = reactor(listener, makeEcho(), { onSession: (session) => void sessions.push(session) });

    await waitUntil(() => channel.listening, "the serve to be listening");
    channel.receive({ $init: { rootName: "echo", parentName: "root", parentIdName: "root" } });
    await waitUntil(() => sessions.length === 1, "the session report");

    channel.receive({ to: ROOT, $tune: { streams: ["message", "state"] } });
    await waitUntil(() => channel.sent.some(isState), "the initial state");
    channel.receive({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 3 } } });
    await waitUntil(() => channel.sent.some(isMsg), "the reply");
    expect(channel.sent.find(isMsg)!.$msg).toMatchObject({ body: { type: "PONG", count: 3 } });

    // The connection is taken once, and saying so beats hanging on a second one.
    const again = listener.accept().then(
      () => "taken twice",
      (error: Error) => error.message,
    );
    expect(await again).toMatch(/already been taken/);

    await r.stop();
  });

  it("releases an accept that is still waiting when it is closed", async () => {
    const listener = oneConnection(() => new Promise<never>(() => {}));
    const settled = listener.accept().then(
      () => "arrived",
      (error: Error) => error.message,
    );

    await listener.close();
    expect(await settled).toMatch(/closed before a connection arrived/);
  });

  it("writes the far end's own output on the channel it serves", async () => {
    const channel = new FakeChannel();
    const listener = oneConnection<Record<string, never>>(() => Promise.resolve(channel));
    const Writing = defineActor({
      name: "writing",
      handlers: {},
      async setup() {
        await this.ctx.connection?.send(outputFrame(1, "printed"));
        return {};
      },
    });
    const r = reactor(listener, Writing);

    await waitUntil(() => channel.listening, "the serve to be listening");
    channel.receive({ $init: { rootName: "echo", parentName: "root", parentIdName: "root" } });

    await waitUntil(() => channel.sent.some((frame) => "$fd" in frame), "the frame");
    expect(channel.sent).toContainEqual({ $fd: 1, data: "printed" });

    await r.stop();
  });
});
