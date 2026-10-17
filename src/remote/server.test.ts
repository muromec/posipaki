// ── serveRemoteActor unit tests (in-memory fake channel) ───────────────────

import { describe, it, expect } from "vitest";
import { defineActor, defineMessages } from "../index.js";
import { serveRemoteActor } from "./reactor.js";
import { ProcessTable, rootIdFor } from "./process-ref.js";
import { decodeFrame, encodeFrame, errorReason, frameReaders, isError, isExit, isMsg, isState } from "./channel.js";
import type { Channel } from "./channel.js";
import { BlobStore } from "./blob.js";
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
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
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

describe("serveRemoteActor (unit)", () => {
  it("handshakes, bridges messages and state, and announces exit", async () => {
    const channel = new FakeChannel();
    const serve = serveRemoteActor(makeEcho(), () => Promise.resolve(channel));

    // 1. awaits $init
    await waitUntil(() => channel.handler !== null, "$init handler");
    channel.handler!({ $init: { parentName: "root", parentIdName: "root" } });

    // 2. says the root's state once it is asked for it, as the far side's proxy does
    channel.handler!({ to: ROOT, $tune: { streams: ["message", "state", "exit"] } });
    await waitUntil(() => channel.sent.some(isState), "initial $state");
    expect(channel.sent.find(isState)!.$state).toEqual({ pings: 0 });

    // 3. forwards $msg → actor → $msg out
    await waitUntil(() => channel.handler !== null, "message handler");
    channel.handler!({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 2 } } });
    await waitUntil(() => channel.sent.some(isMsg), "$msg reply");
    expect(channel.sent.find(isMsg)!.$msg).toMatchObject({
      fromName: "remote",
      body: { type: "PONG", count: 2 },
    });

    // 4. STOP → $exit + close
    channel.handler!({ to: ROOT, $msg: { fromName: "root", body: { type: "STOP" } } });
    await waitUntil(() => channel.sent.some(isExit), "$exit");

    await serve;
    expect(channel.closed).toBe(true);
    expect(channel.sent.find(isExit)!.$exit.code).toBe(0);
  });

  it("stops the served actor when the wire goes", async () => {
    let stopped = false;
    const Watched = defineActor({
      name: "watched",
      inMessages: defineMessages<{ type: "PING"; count: number }>(),
      outMessages: defineMessages<{ type: "PONG"; count: number }>(),
      setup: () => ({ pings: 0 }),
      onStopRequested() {
        stopped = true;
        this.agreeToStop();
      },
      handlers: {
        async PING(msg: { type: "PING"; count: number }) {
          this.state.pings += 1;
          await this.emit({ type: "PONG", count: msg.count });
        },
      },
    });

    const channel = new FakeChannel();
    const serve = serveRemoteActor(Watched, () => Promise.resolve(channel));

    await waitUntil(() => channel.handler !== null, "$init handler");
    channel.handler!({ $init: { parentName: "root", parentIdName: "root" } });

    // The dispatch handler replaces the one that took the handshake a moment later, and nothing is
    // said to a far side that has not asked to hear it: ask for the streams and say a word, until
    // the word is answered.  A frame dropped into the gap between the two handlers is a frame lost.
    const deadline = Date.now() + 5000;
    while (!channel.sent.some(isMsg) && Date.now() < deadline) {
      if (channel.handler) {
        channel.handler({ to: ROOT, $tune: { streams: ["message", "state", "exit"] } });
        channel.handler({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 1 } } });
      }
      await sleep(5);
    }
    expect(channel.sent.some(isMsg)).toBe(true);

    // The wire goes: the client is gone, and the actor has nobody left to answer.
    channel.closeHandler!();

    await serve;
    expect(stopped).toBe(true);
  });

  it("gives the served process the connection it is served over", async () => {
    // The channel above the protocol step is the process's own connection: what it would write
    // a stream of its own on, rather than something only the session factory can see.
    let held: unknown = "never read";
    const Holder = defineActor({
      name: "holder",
      handlers: {},
      setup() {
        held = this.ctx.connection;
        return {};
      },
    });

    const channel = new FakeChannel();
    const serve = serveRemoteActor(Holder, () => Promise.resolve(channel));

    await waitUntil(() => channel.handler !== null, "$init handler");
    channel.handler!({ $init: { parentName: "root", parentIdName: "root" } });
    await waitUntil(() => held !== "never read", "the process to start");

    expect(held).toBe(channel);

    channel.closeHandler!();
    await serve;
  });

  it("does not emit initial $state before $init", async () => {
    const channel = new FakeChannel();
    const serve = serveRemoteActor(makeEcho(), () => Promise.resolve(channel));

    await waitUntil(() => channel.handler !== null, "$init handler");
    expect(channel.sent.filter(isState)).toEqual([]);

    channel.handler!({ $init: { parentName: "root", parentIdName: "root" } });
    channel.handler!({ to: ROOT, $tune: { streams: ["message", "state", "exit"] } });
    await waitUntil(() => channel.sent.some(isState), "initial $state");
    await waitUntil(() => channel.handler !== null, "message handler");
    channel.handler!({ to: ROOT, $msg: { fromName: "root", body: { type: "STOP" } } });
    await serve;
  });
  it("refuses a connection whose first frame could not be read, and says why", async () => {
    const channel = new FakeChannel();
    const serve = serveRemoteActor(makeEcho(), () => Promise.resolve(channel));

    await waitUntil(() => channel.handler !== null, "$init handler");
    // What the codec hands the seam for a line that is not a frame at all: here it arrives where
    // the connection is being made, which is a failed start like any other — refused to whoever
    // opened the connection, and the far side told what was wrong with what it said.
    channel.handler!({ $bad: { reason: "Unexpected token 'n'", length: 13, prefix: "not-json-17" } });

    await expect(serve).rejects.toThrow(/expected \$init/);
    expect(errorReason(channel.sent.find(isError)!)).toContain("expected $init");
  });

  it("says what it could not read, and ends that connection", async () => {
    const channel = new FakeChannel();
    const serve = serveRemoteActor(makeEcho(), () => Promise.resolve(channel));

    await waitUntil(() => channel.handler !== null, "$init handler");
    channel.handler!({ $init: { parentName: "root", parentIdName: "root" } });

    // The dispatch handler replaces the one that took the handshake a moment later, and a frame
    // dropped into the gap between the two is a frame lost: ask to hear about the root, and say the
    // unreadable frame, until it is answered.
    const deadline = Date.now() + 5000;
    while (!channel.sent.some(isError) && Date.now() < deadline) {
      channel.handler?.({ to: ROOT, $tune: { streams: ["message", "state", "exit"] } });
      channel.handler?.({ $bad: { reason: "Unexpected token 'n'", length: 13, prefix: "not-json-17" } });
      await sleep(5);
    }

    // The connection is over: the actor spawned for it ends with it, and the serving call returns
    // to whoever opened the connection.
    await serve;
    expect(channel.closed).toBe(true);

    // What was said, in the order it was said: what could not be read, then the end of the root.
    const said = channel.sent
      .map((frame) => (isError(frame) ? "$error" : isExit(frame) ? "$exit" : null))
      .filter((what) => what !== null);
    expect(said).toEqual(["$error", "$exit"]);
    expect(errorReason(channel.sent.find(isError)!)).toBe("Unexpected token 'n'");
  });

  it("costs one connection, and not the process", async () => {
    // Two connections, the way a host process serves them: one actor each, and a bad frame on one
    // of them is not news the other one ever hears.
    const broken = new FakeChannel();
    const brokenServe = serveRemoteActor(makeEcho(), () => Promise.resolve(broken));
    await waitUntil(() => broken.handler !== null, "$init handler");
    broken.handler!({ $init: { parentName: "root", parentIdName: "root" } });

    const serving = new FakeChannel();
    const servingServe = serveRemoteActor(makeEcho(), () => Promise.resolve(serving));
    await waitUntil(() => serving.handler !== null, "$init handler");
    serving.handler!({ $init: { parentName: "root", parentIdName: "root" } });

    const deadline = Date.now() + 5000;
    while (!broken.sent.some(isError) && Date.now() < deadline) {
      broken.handler?.({ $bad: { reason: "not a frame", length: 3, prefix: "no!" } });
      await sleep(5);
    }
    await brokenServe;
    expect(broken.closed).toBe(true);

    // The other connection is still served: still asked, still answered.
    let answered: unknown = null;
    const until = Date.now() + 5000;
    while (answered === null && Date.now() < until) {
      serving.handler?.({ to: ROOT, $tune: { streams: ["message", "state", "exit"] } });
      serving.handler?.({ to: ROOT, $msg: { fromName: "root", body: { type: "PING", count: 3 } } });
      answered = serving.sent.find(isMsg) ?? null;
      await sleep(5);
    }
    expect((answered as { $msg: { body: unknown } }).$msg.body).toEqual({ type: "PONG", count: 3 });

    serving.handler!({ to: ROOT, $msg: { fromName: "root", body: { type: "STOP" } } });
    await servingServe;
  });
});

describe("bytes across the seam", () => {
  /** A channel with several readers, and a far side to hand frames to: the fake above holds
   *  one handler, and the point here is that the served actor and its blob store are two. */
  class MultiChannel implements Channel {
    readonly sent: Record<string, unknown>[] = [];
    /** How many readers have asked to be handed frames: the server installs one before it
     *  says anything, and a frame sent before that is a frame nobody held. */
    subscribed = 0;
    private deliver: (frame: Record<string, unknown>) => void = () => {};
    private readonly readers = frameReaders((deliver) => {
      this.deliver = deliver;
    });

    async send(frame: Record<string, unknown>): Promise<void> {
      this.sent.push(frame);
    }
    onMessage(handler: (frame: Record<string, unknown>) => void): () => void {
      this.subscribed += 1;
      return this.readers(handler);
    }
    onClose(): void {
      /* the test closes nothing */
    }
    async close(): Promise<void> {
      /* nothing to release */
    }
    receive(frame: Record<string, unknown>): void {
      this.deliver(frame);
    }
  }

  /** Two channels, each the other's far side: what one sends, the other is handed. */
  function bridge(): [MultiChannel, MultiChannel] {
    const served = new MultiChannel();
    const client = new MultiChannel();
    served.send = async (frame: Record<string, unknown>) => {
      served.sent.push(frame);
      client.receive(frame);
    };
    client.send = async (frame: Record<string, unknown>) => {
      client.sent.push(frame);
      served.receive(frame);
    };
    return [served, client];
  }

  it("hands a byte array to the served actor as a value it can await, and back again", async () => {
    const [servedChannel, clientChannel] = bridge();
    // The client side first: it must be listening before the server says anything.
    const clientBlobs = new BlobStore(clientChannel, "odd");
    const table = new ProcessTable("odd");

    /** What the served actor does with what it was handed: await it, and send it back. */
    const Ear = defineActor({
      name: "ear",
      inMessages: defineMessages<{ type: "PING"; count: number; file?: unknown }>(),
      outMessages: defineMessages<{ type: "PONG"; count: number; file?: unknown; length?: number }>(),
      setup: () => ({ pings: 0 }),
      handlers: {
        async PING(msg: { type: "PING"; count: number; file?: unknown }) {
          // The same line an application writes when the peer is a process in this one.
          const bytes = new Uint8Array((await msg.file) as ArrayLike<number>);
          this.state.pings += 1;
          await this.emit({ type: "PONG", count: msg.count, file: bytes, length: bytes.byteLength });
        },
      },
    });

    const serve = serveRemoteActor(Ear, () => Promise.resolve(servedChannel));
    await waitUntil(() => servedChannel.subscribed > 0, "the serving side's handler");

    const send = (frame: Record<string, unknown>): Promise<void> =>
      Promise.resolve(clientChannel.send(encodeFrame(frame, table, rootIdFor("even"), clientBlobs)));

    await send({ $init: { parentName: "root", parentIdName: "root" } });
    await send({ $tune: { streams: ["message", "state", "exit"] } });

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80, 0xc3, 0xa9, 0x0d, 0x0a]);
    await send({ $msg: { fromName: "root", body: { type: "PING", count: 3, file: bytes } } });
    const answer = await (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const frame = servedChannel.sent.map((raw) => decodeFrame(raw, (ref) => ref, clientBlobs)).find(isMsg);
        if (frame) return frame as unknown as { $msg: { body: Record<string, unknown> } };
        await sleep(1);
      }
      throw new Error("no $msg answer from the served actor");
    })();

    const body = answer.$msg.body;
    expect(body.type).toBe("PONG");
    expect(body.count).toBe(3);
    // The value the actor got was the bytes it was sent: it counted them.
    expect(body.length).toBe(bytes.byteLength);
    // …and the bytes it sent back cross as a value this side awaits for the same octets.
    const back = await (body.file as PromiseLike<Uint8Array>);
    expect(Array.from(back)).toEqual(Array.from(bytes));

    await send({ $msg: { fromName: "root", body: { type: "STOP" } } });
    await serve;
  });
});
