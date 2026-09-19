// ── reflection over the seam ───────────────────────────────────────────────
//
// Two halves, looked at one at a time through a fake channel: the server
// announces what it can answer and dispatches a call to the method it named,
// and the client installs one function per announced name and pairs each answer
// back to the call that is waiting for it.

import { describe, it, expect } from "vitest";
import { defineActor } from "../index.js";
import { remoteClient } from "./client.js";
import { serveRemoteActor } from "./server.js";
import {
  REFLECT_CALL,
  REFLECT_METHODS,
  REFLECT_RESULT,
  asReflectionCall,
  asReflectionResult,
  decodeFrame,
  encodeFrame,
  frameTo,
  isExit,
  isMsg,
  isPause,
  isReflectionMethods,
  isResume,
  isState,
  isStop,
  jsonProblem,
} from "./channel.js";
import type { Channel } from "./channel.js";
import {
  PROCESS_REF,
  ROOT_ID,
  ProcessTable,
  isRemoteProcess,
  type ProcessRef,
} from "./process-ref.js";
import { RemoteProcess } from "./remote-process.js";
import type { Message } from "../types.js";
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

async function waitUntil(predicate: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(1);
  }
}

function frameKey(frame: Record<string, unknown>, prefix: string): string | undefined {
  return Object.keys(frame).find((key) => key.startsWith(prefix));
}

function answerFor(channel: FakeChannel, method: string): Record<string, unknown> | undefined {
  const key = `${REFLECT_RESULT}${method}`;
  const frame = channel.sent.find((f) => key in f);
  return frame?.[key] as Record<string, unknown> | undefined;
}

function answersFor(channel: FakeChannel, method: string): Record<string, unknown>[] {
  const key = `${REFLECT_RESULT}${method}`;
  return channel.sent.filter((f) => key in f).map((f) => f[key] as Record<string, unknown>);
}

type Surface = Record<string, (...args: unknown[]) => Promise<unknown>>;
type Stoppable = { stop(): Promise<boolean>; wait(): Promise<unknown> };

/** A handle with a sink that goes nowhere: what these tests need of one is that
 *  it exists and can be told where it came from. */
function makeHandle(ref: ProcessRef): RemoteProcess {
  return new RemoteProcess(ref, () => {}, "here");
}

// ── the client half ────────────────────────────────────────────────────────

async function spawnProxy(announce: string[] | null) {
  const channel = new FakeChannel();
  const actor = remoteClient<Record<string, unknown>, { ready: boolean }, Message, Message>(
    "probe",
    () => Promise.resolve(channel),
  );
  const proc = await actor.spawn({}, { awaitReady: false });
  await waitUntil(() => channel.handler !== null, "the handshake handler");
  if (announce) channel.handler!({ [REFLECT_METHODS]: announce });
  channel.handler!({ $state: { ready: true } });
  await proc.ready();
  return { channel, proc, surface: proc.$reflection as unknown as Surface };
}

/** Let the proxy end: it asks the far side to stop, and the far side says so. */
async function endProxy(channel: FakeChannel, proc: Stoppable): Promise<void> {
  const stopping = proc.stop();
  await waitUntil(() => channel.sent.some((frame) => JSON.stringify(frame).includes('"STOP"')), "STOP out");
  channel.handler?.({ $exit: { code: 0, state: {} } });
  await stopping;
}

describe("remoteClient reflection", () => {
  it("installs one function per announced name and answers it by seq", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.echo"]);

    expect(typeof surface["probe.echo"]).toBe("function");
    const answer = surface["probe.echo"]!("hi");

    const call = frameKey(channel.sent.find((f) => frameKey(f, REFLECT_CALL)) ?? {}, REFLECT_CALL)!;
    expect(call).toBe(`${REFLECT_CALL}probe.echo`);
    expect(channel.sent.find((f) => frameKey(f, REFLECT_CALL))![call]).toEqual({
      seq: 1,
      args: ["hi"],
    });

    channel.handler!({ [`${REFLECT_RESULT}probe.echo`]: { seq: 1, value: "echo:hi" } });
    expect(await answer).toBe("echo:hi");

    await endProxy(channel, proc);
  });

  it("leaves a name the far side never announced uncallable", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.echo"]);

    expect(surface["probe.other"]).toBeUndefined();
    expect(channel.sent.filter((f) => frameKey(f, REFLECT_CALL))).toEqual([]);

    await endProxy(channel, proc);
  });

  it("tells two calls to the same method apart, and takes the answers in any order", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.late"]);

    const first = surface["probe.late"]!(30);
    const second = surface["probe.late"]!(0);
    const calls = channel.sent.filter((f) => frameKey(f, REFLECT_CALL));
    expect(calls.length).toBe(2);
    const seqs = calls.map((f) => (f[frameKey(f, REFLECT_CALL)!] as { seq: number }).seq);
    expect(seqs).toEqual([1, 2]);

    // The second call answers first — the seq, not the order, says who it is.
    channel.handler!({ [`${REFLECT_RESULT}probe.late`]: { seq: 2, value: "second" } });
    expect(await second).toBe("second");
    channel.handler!({ [`${REFLECT_RESULT}probe.late`]: { seq: 1, value: "first" } });
    expect(await first).toBe("first");

    await endProxy(channel, proc);
  });

  it("turns a refused call into a rejection naming the method", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.boom"]);

    const answer = surface["probe.boom"]!();
    channel.handler!({ [`${REFLECT_RESULT}probe.boom`]: { seq: 1, error: "probe said no" } });
    await expect(answer).rejects.toThrow("probe.boom: probe said no");

    await endProxy(channel, proc);
  });

  it("fails a call that was in flight when the wire went away", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.echo"]);

    const answer = surface["probe.echo"]!("hi");
    channel.closeHandler!();
    await expect(answer).rejects.toThrow("connection closed before probe.echo answered");

    await endProxy(channel, proc);
  });

  it("honours an announcement that arrives after the first $state", async () => {
    const { channel, proc, surface } = await spawnProxy(null);
    expect(surface["probe.echo"]).toBeUndefined();

    channel.handler!({ [REFLECT_METHODS]: ["probe.echo"] });
    expect(typeof surface["probe.echo"]).toBe("function");

    await endProxy(channel, proc);
  });
});

// ── the client half: what comes back ───────────────────────────────────────

/** A process of this side's own, with something to say when it is spoken to: a
 *  worker the far side can only see work through what it streams. */
const Echo = defineActor({
  name: "mine",
  $reflectionMethods: {
    async "echo.pings"() {
      return this.state.pings;
    },
  },
  async setup() {
    return { pings: 0 };
  },
  handlers: {
    async PING() {
      this.state.pings += 1;
      this.ctx.notify();
      await this.emit({ type: "PONG" });
    },
  },
});

describe("remoteClient process references", () => {
  it("makes a handle of a reference it is handed", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.child"]);

    const answer = surface["probe.child"]!();
    channel.handler!({
      [`${REFLECT_RESULT}probe.child`]: { seq: 1, value: { [PROCESS_REF]: { id: 4, pname: "tools:kid" } } },
    });

    const found = (await answer) as RemoteProcess;
    expect(found).toBeInstanceOf(RemoteProcess);
    expect(found.ref.id).toBe(4);
    expect(found.pname).toBe("tools:kid");
    expect(found.isConnected()).toBe(true);

    await endProxy(channel, proc);
  });

  it("hands back the same handle for the same process, and sends to it by its id", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.child", "probe.use"]);

    const first = surface["probe.child"]!();
    channel.handler!({
      [`${REFLECT_RESULT}probe.child`]: { seq: 1, value: { [PROCESS_REF]: { id: 4, pname: "tools:kid" } } },
    });
    const handle = (await first) as RemoteProcess;

    const second = surface["probe.child"]!();
    channel.handler!({
      [`${REFLECT_RESULT}probe.child`]: { seq: 2, value: { [PROCESS_REF]: { id: 4, pname: "tools:kid" } } },
    });
    // Handed over twice, it is one process, so it is one handle.
    expect(await second).toBe(handle);

    handle.send({ type: "PING" });
    const sent = channel.sent.find((f) => frameTo(f) === 4 && isMsg(f));
    expect(sent?.$msg).toEqual({ fromName: "probe", body: { type: "PING" } });

    await endProxy(channel, proc);
  });

  it("lets a handle go when the connection goes, and refuses to send after that", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.child"]);

    const answer = surface["probe.child"]!();
    channel.handler!({
      [`${REFLECT_RESULT}probe.child`]: { seq: 1, value: { [PROCESS_REF]: { id: 4, pname: "tools:kid" } } },
    });
    const handle = (await answer) as RemoteProcess;

    channel.closeHandler!();

    expect(handle.isConnected()).toBe(false);
    expect(() => handle.send({ type: "PING" })).toThrow(/cannot be reached/);

    await endProxy(channel, proc);
  });

  it("finds a reference wherever it came in the answer", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.children"]);

    const answer = surface["probe.children"]!();
    channel.handler!({
      [`${REFLECT_RESULT}probe.children`]: {
        seq: 1,
        value: { kids: [{ [PROCESS_REF]: { id: 1, pname: "a" } }] },
      },
    });

    const value = (await answer) as { kids: RemoteProcess[] };
    expect(value.kids[0]).toBeInstanceOf(RemoteProcess);

    await endProxy(channel, proc);
  });

  it("writes a reference back into the frame, with the id it came with", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.use"]);

    const ref = makeHandle({ id: 4, pname: "tools:kid" });
    const answer = surface["probe.use"]!([ref]);
    await waitUntil(() => channel.sent.some((f) => frameKey(f, REFLECT_CALL)), "the call");

    const call = channel.sent.find((f) => frameKey(f, REFLECT_CALL))!;
    expect(call[`${REFLECT_CALL}probe.use`]).toEqual({
      seq: 1,
      args: [[{ [PROCESS_REF]: { id: 4, pname: "tools:kid" } }]],
    });

    channel.handler!({ [`${REFLECT_RESULT}probe.use`]: { seq: 1, value: true } });
    expect(await answer).toBe(true);

    await endProxy(channel, proc);
  });

  it("writes a process of mine as a reference, numbered by this side", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.use"]);

    const mine = await defineActor({ name: "mine", handlers: {} }).spawn({});
    const answer = surface["probe.use"]!(mine);
    await waitUntil(() => channel.sent.some((f) => frameKey(f, REFLECT_CALL)), "the call");

    const call = channel.sent.find((f) => frameKey(f, REFLECT_CALL))!;
    expect(call[`${REFLECT_CALL}probe.use`]).toEqual({
      seq: 1,
      args: [{ [PROCESS_REF]: { id: 1, pname: "mine" } }],
    });

    channel.handler!({ [`${REFLECT_RESULT}probe.use`]: { seq: 1, value: true } });
    await answer;
    await mine.stop();

    await endProxy(channel, proc);
  });
});

describe("a process of this side, handed over", () => {
  it("streams it from the moment it crossed", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.use"]);

    const mine = await Echo.spawn({});
    const answer = surface["probe.use"]!(mine);
    await waitUntil(() => channel.sent.some((f) => frameKey(f, REFLECT_CALL)), "the call");

    // What it can answer, then what it holds — both after the frame that carried
    // the reference, since a far side told about a process it cannot name yet has
    // nowhere to put the news.
    const carrying = channel.sent.findIndex((f) => frameKey(f, REFLECT_CALL));
    const announced = channel.sent.findIndex((f) => f.to === 1 && isReflectionMethods(f));
    const state = channel.sent.findIndex((f) => f.to === 1 && isState(f));
    expect(carrying).toBeGreaterThanOrEqual(0);
    expect(announced).toBeGreaterThan(carrying);
    expect(state).toBeGreaterThan(announced);
    expect(channel.sent[announced][REFLECT_METHODS]).toEqual(["echo.pings"]);
    expect(channel.sent[state].$state).toEqual({ pings: 0 });

    channel.handler!({ [`${REFLECT_RESULT}probe.use`]: { seq: 1, value: true } });
    await answer;
    await mine.stop();

    await endProxy(channel, proc);
  });

  it("delivers a message the far side sent to it where it lives, and says what it did about it", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.use"]);

    const mine = await Echo.spawn({});
    const answer = surface["probe.use"]!(mine);
    await waitUntil(() => channel.sent.some((f) => frameKey(f, REFLECT_CALL)), "the call");
    channel.handler!({ [`${REFLECT_RESULT}probe.use`]: { seq: 1, value: true } });
    await answer;

    channel.handler!({ to: 1, $msg: { fromName: "remote", body: { type: "PING" } } });
    await waitUntil(() => (mine.state as unknown as { pings: number }).pings === 1, "the work it did");

    // And what it did about it crosses back, addressed to the process that asked.
    await waitUntil(() => channel.sent.some((f) => f.to === 1 && isMsg(f)), "what it said");
    const told = channel.sent.find((f) => f.to === 1 && isMsg(f));
    expect(told?.$msg).toEqual({ fromName: "mine", body: { type: "PONG" } });

    await mine.stop();
    await endProxy(channel, proc);
  });
  it("makes a handle of a reference that arrived inside a message body", async () => {
    const { channel, proc } = await spawnProxy(["probe.ask"]);
    const heard: Message[] = [];
    proc.subscribe("message", (msg) => heard.push(msg as Message));

    channel.handler!({
      to: ROOT_ID,
      $msg: {
        fromName: "remote",
        body: { type: "KID", kid: { [PROCESS_REF]: { id: 4, pname: "remote:kid" } } },
      },
    });

    await waitUntil(() => heard.length > 0, "the message");
    const kid = (heard[0] as { kid?: unknown }).kid;
    expect(isRemoteProcess(kid)).toBe(true);
    expect((kid as RemoteProcess).pname).toBe("remote:kid");

    await endProxy(channel, proc);
  });

  it("writes a process of mine wherever it sits in a frame, and numbers it once", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.use"]);

    const mine = await Echo.spawn({});
    const answer = surface["probe.use"]!({ kids: [mine, { second: mine }] });
    await waitUntil(() => channel.sent.some((f) => frameKey(f, REFLECT_CALL)), "the call");

    const expected = { [PROCESS_REF]: { id: 1, pname: "mine" } };
    const call = channel.sent.find((f) => frameKey(f, REFLECT_CALL))!;
    expect(call[`${REFLECT_CALL}probe.use`]).toEqual({
      seq: 1,
      args: [{ kids: [expected, { second: expected }] }],
    });

    channel.handler!({ [`${REFLECT_RESULT}probe.use`]: { seq: 1, value: true } });
    await answer;
    await mine.stop();

    await endProxy(channel, proc);
  });

  it("keeps a handle of the process the state replaces it with", async () => {
    const channel = new FakeChannel();
    const actor = remoteClient<Record<string, unknown>, { kid?: RemoteProcess }, Message, Message>(
      "probe",
      () => Promise.resolve(channel),
    );
    const proc = await actor.spawn({}, { awaitReady: false });
    await waitUntil(() => channel.handler !== null, "the handshake handler");

    channel.handler!({ $state: { kid: { [PROCESS_REF]: { id: 2, pname: "remote:one" } } } });
    await proc.ready();
    const first = (proc.state as { kid?: RemoteProcess }).kid;
    expect(first?.pname).toBe("remote:one");

    channel.handler!({ $state: { kid: { [PROCESS_REF]: { id: 4, pname: "remote:two" } } } });
    await waitUntil(
      () => (proc.state as { kid?: RemoteProcess }).kid?.pname === "remote:two",
      "the process that replaced it",
    );

    const second = (proc.state as { kid?: RemoteProcess }).kid;
    expect(second).not.toBe(first);
    expect(second?.ref.id).toBe(4);

    await endProxy(channel, proc);
  });
  it("stops a process of mine when the far side asks, and tells it that it ended", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.use"]);

    const mine = await Echo.spawn({});
    const answer = surface["probe.use"]!(mine);
    await waitUntil(() => channel.sent.some((f) => frameKey(f, REFLECT_CALL)), "the call");
    channel.handler!({ [`${REFLECT_RESULT}probe.use`]: { seq: 1, value: true } });
    await answer;

    channel.handler!({ to: 1, $stop: {} });
    await mine.wait();

    // Its exit crosses back like everything else it does: the far side asked, so
    // it is the one that has to be told.
    await waitUntil(() => channel.sent.some((f) => f.to === 1 && isExit(f)), "its exit");
    const exit = channel.sent.find((f) => f.to === 1 && isExit(f));
    expect(exit?.$exit).toEqual({ code: 0, state: { pings: 0 } });

    await endProxy(channel, proc);
  });

  it("holds a process of mine back while the far side has it paused", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.use"]);

    const mine = await Echo.spawn({});
    const answer = surface["probe.use"]!(mine);
    await waitUntil(() => channel.sent.some((f) => frameKey(f, REFLECT_CALL)), "the call");
    channel.handler!({ [`${REFLECT_RESULT}probe.use`]: { seq: 1, value: true } });
    await answer;

    channel.handler!({ to: 1, $pause: {} });
    channel.handler!({ to: 1, $msg: { fromName: "remote", body: { type: "PING" } } });
    await sleep(20);
    expect((mine.state as unknown as { pings: number }).pings).toBe(0);

    channel.handler!({ to: 1, $resume: {} });
    await waitUntil(() => (mine.state as unknown as { pings: number }).pings === 1, "the message it took");

    await mine.stop();
    await endProxy(channel, proc);
  });

  it("lets a process of mine go when the far side does, and stops speaking for it", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.use"]);

    const mine = await Echo.spawn({});
    const answer = surface["probe.use"]!(mine);
    await waitUntil(() => channel.sent.some((f) => frameKey(f, REFLECT_CALL)), "the call");
    channel.handler!({ [`${REFLECT_RESULT}probe.use`]: { seq: 1, value: true } });
    await answer;
    await waitUntil(() => channel.sent.some((f) => f.to === 1 && isState(f)), "the state it streamed");

    channel.handler!({ to: 1, $release: {} });
    await sleep(10);
    channel.sent.length = 0;

    // The id is this connection's no longer: a message for it goes nowhere, and
    // what the process does is not this connection's news.
    channel.handler!({ to: 1, $msg: { fromName: "remote", body: { type: "PING" } } });
    await sleep(20);
    expect((mine.state as unknown as { pings: number }).pings).toBe(0);
    expect(channel.sent).toEqual([]);

    await mine.stop();
    await endProxy(channel, proc);
  });

  it("takes the far side's word that a handle it gave is gone", async () => {
    const channel = new FakeChannel();
    const actor = remoteClient<Record<string, unknown>, { kid?: RemoteProcess }, Message, Message>(
      "probe",
      () => Promise.resolve(channel),
    );
    const proc = await actor.spawn({}, { awaitReady: false });
    await waitUntil(() => channel.handler !== null, "the handshake handler");
    channel.handler!({ $state: { kid: { [PROCESS_REF]: { id: 2, pname: "remote:kid" } } } });
    await proc.ready();

    const kid = (proc.state as { kid?: RemoteProcess }).kid!;
    const waiting = kid.wait();
    channel.handler!({ to: 2, $exit: { code: 0, state: { pings: 2 } } });

    expect(await waiting).toEqual({ code: 0, state: { pings: 2 } });
    expect(kid.hasEnded()).toBe(true);
    expect(() => kid.send({ type: "PING" })).toThrow(/has ended/);

    await endProxy(channel, proc);
  });
});

// ── where a frame goes ─────────────────────────────────────────────────────

describe("the address on a frame", () => {
  it("names the root by saying nothing, and an id otherwise", () => {
    expect(frameTo({ $msg: {} })).toBe(ROOT_ID);
    expect(frameTo({ $msg: {}, to: ROOT_ID })).toBe(ROOT_ID);
    expect(frameTo({ $msg: {}, to: 4 })).toBe(4);
    expect(frameTo({ $msg: {}, to: "4" })).toBeNull();
  });

  it("walks a whole frame out: processes become references, the address an id", async () => {
    const mine = await defineActor({ name: "mine", handlers: {} }).spawn({});
    const table = new ProcessTable("odd");

    const frame = encodeFrame({ $msg: { fromName: "local", body: { kid: mine } } }, table);
    expect(frame).toEqual({
      $msg: { fromName: "local", body: { kid: { [PROCESS_REF]: { id: 1, pname: "mine" } } } },
    });
    // A frame for the root carries no address: that is what it always meant.
    expect("to" in frame).toBe(false);
    expect(encodeFrame({ $msg: { fromName: "local", body: {} } }, table, 1).to).toBe(1);

    await mine.stop();
  });

  it("walks a whole frame in: references become what this side knows of them", () => {
    const frame = decodeFrame(
      { $msg: { fromName: "far", body: { kid: { [PROCESS_REF]: { id: 4, pname: "theirs" } } } } },
      makeHandle,
    );
    const kid = (frame.$msg as { body: { kid: RemoteProcess } }).body.kid;

    expect(kid).toBeInstanceOf(RemoteProcess);
    expect(kid.ref.id).toBe(4);
    expect(kid.pname).toBe("theirs");
  });

  it("makes a handle of a reference that arrives on the state", async () => {
    const channel = new FakeChannel();
    const actor = remoteClient<
      Record<string, unknown>,
      { kid?: RemoteProcess },
      Message,
      Message
    >("probe", () => Promise.resolve(channel));
    const proc = await actor.spawn({}, { awaitReady: false });
    await waitUntil(() => channel.handler !== null, "the handshake handler");

    channel.handler!({ $state: { kid: { [PROCESS_REF]: { id: 2, pname: "remote:kid" } } } });
    await proc.ready();

    const kid = (proc.state as unknown as { kid?: RemoteProcess }).kid;
    expect(kid).toBeInstanceOf(RemoteProcess);
    expect(kid?.pname).toBe("remote:kid");

    await endProxy(channel, proc);
  });

  it("takes a state frame for the root and drops one for a process it does not hold", async () => {
    const channel = new FakeChannel();
    const actor = remoteClient<
      Record<string, unknown>,
      { ready?: boolean; stray?: boolean },
      Message,
      Message
    >("probe", () => Promise.resolve(channel));
    const proc = await actor.spawn({}, { awaitReady: false });
    await waitUntil(() => channel.handler !== null, "the handshake handler");

    channel.handler!({ to: 5, $state: { stray: true } });
    channel.handler!({ to: ROOT_ID, $state: { ready: true } });
    await proc.ready();

    expect(proc.state).toEqual({ ready: true });

    await endProxy(channel, proc);
  });

  it("emits a message the root sent, and drops one for a process it does not hold", async () => {
    const { channel, proc } = await spawnProxy(["probe.ask"]);
    const seen: Message[] = [];
    proc.subscribe("message", (msg) => {
      seen.push(msg as Message);
    });

    channel.handler!({ to: 5, $msg: { fromName: "remote", body: { type: "PING" } } });
    channel.handler!({ to: ROOT_ID, $msg: { fromName: "remote", body: { type: "PONG" } } });
    await waitUntil(() => seen.length > 0, "the message");
    await sleep(5);

    expect(seen).toEqual([{ type: "PONG" }]);

    await endProxy(channel, proc);
  });
});

// ── the server half ────────────────────────────────────────────────────────

const Leaf = defineActor({
  name: "leaf",
  plugins: [],
  handlers: {
    async PING() {
      await this.emit({ type: "PONG" });
    },
  },
});

function makeProbe() {
  let held: RemoteProcess | null = null;
  return defineActor({
    name: "probe",
    $reflectionMethods: {
      async "probe.add"(a: number, b: number) {
        return a + b;
      },
      async "probe.child"() {
        return this.ctx.children[0];
      },
      async "probe.children"() {
        return this.ctx.children;
      },
      async "probe.who"() {
        return { pname: this.name, kids: this.ctx.children.map((child) => child.pname) };
      },
      "probe.late"(ms: number) {
        return new Promise((resolve) => setTimeout(() => resolve(`late:${ms}`), ms));
      },
      async "probe.boom"() {
        throw new Error("probe said no");
      },
      async "probe.refusing"() {
        return () => 1;
      },
      async "probe.expose"() {
        // Put a child on the public state: what a frame does with a process in it
        // is the walk's business, and this is where that shows.
        (this.state as unknown as Record<string, unknown>).child = this.ctx.children[0];
        this.ctx.notify();
        return this.name;
      },
      async "probe.whatItGot"(value: unknown) {
        return isRemoteProcess(value)
          ? { reference: value.pname, id: value.ref.id }
          : { plain: true };
      },
      async "probe.take"(value: unknown) {
        // Hold on to what was handed over, so what the far side says about it
        // later has somewhere to land.
        held = isRemoteProcess(value) ? value : null;
        return held ? held.ref.id : null;
      },
      async "probe.held"() {
        return held ? { pname: held.pname, state: held.state } : null;
      },
      async "probe.stateOf"() {
        return this.state;
      },
      async "probe.sendChild"() {
        // A process of this side's own, inside a message body: the walk finds it
        // wherever it sits.
        await this.emit({ type: "KID", kid: this.ctx.children[0] } as unknown as Message);
      },
      async "probe.swap"() {
        // Another process of this side's, on the state in place of the one before.
        (this.state as unknown as Record<string, unknown>).child = this.ctx.children[1];
        this.ctx.notify();
        return this.name;
      },
    },
    async setup() {
      await this.fork(Leaf, undefined, { name: "one" });
      await this.fork(Leaf, undefined, { name: "two" });
      return { hits: 0 };
    },
    handlers: {
      async KEEP(msg: Message) {
        // A process handed over inside a message body: the walk puts a handle in
        // its place before the actor is given the message at all.
        const kid = (msg as { kid?: unknown }).kid;
        held = isRemoteProcess(kid) ? kid : null;
        (this.state as unknown as Record<string, unknown>).kept = held?.pname ?? null;
        this.ctx.notify();
      },
    },
  });
}

async function serveProbe() {
  const channel = new FakeChannel();
  const served = serveRemoteActor(makeProbe(), () => Promise.resolve(channel));
  await waitUntil(() => channel.handler !== null, "$init handler");
  channel.handler!({ $init: { parentName: "root", parentIdName: "root" } });
  await waitUntil(() => channel.sent.some(isState), "the first $state");
  return { channel, served };
}

async function endServer(channel: FakeChannel, served: Promise<void>): Promise<void> {
  channel.handler!({ $msg: { fromName: "root", body: { type: "STOP" } } });
  await served;
}

/** The states the root published, in order: the frames that carry no address.
 *  A process that crosses has states of its own, and one of them can be null. */
function rootStates(channel: FakeChannel): Array<{ $state: Record<string, unknown> }> {
  return channel.sent
    .filter(isState)
    .filter((frame) => (frame as Record<string, unknown>).to === undefined);
}

describe("serveRemoteActor reflection", () => {
  it("announces its methods before the first $state", async () => {
    const { channel, served } = await serveProbe();

    const announced = channel.sent.findIndex((frame) => isReflectionMethods(frame));
    const state = channel.sent.findIndex(isState);
    expect(announced).toBeGreaterThanOrEqual(0);
    expect(announced).toBeLessThan(state);
    expect(channel.sent[announced][REFLECT_METHODS]).toEqual([
      "probe.add",
      "probe.child",
      "probe.children",
      "probe.who",
      "probe.late",
      "probe.boom",
      "probe.refusing",
      "probe.expose",
      "probe.whatItGot",
      "probe.take",
      "probe.held",
      "probe.stateOf",
      "probe.sendChild",
      "probe.swap",
    ]);

    await endServer(channel, served);
  });

  it("calls the named method and answers with what it returned", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.add`]: { seq: 7, args: [40, 2] } });
    await waitUntil(() => answerFor(channel, "probe.add") !== undefined, "the answer");
    expect(answerFor(channel, "probe.add")).toEqual({ seq: 7, value: 42 });

    await endServer(channel, served);
  });

  it("runs the method on the actor, so it sees the process it was spawned as", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.who`]: { seq: 1, args: [] } });
    await waitUntil(() => answerFor(channel, "probe.who") !== undefined, "the answer");
    // `this.name` is the name the seam spawned the far side under, not the name
    // in the definition: the caller's own name for it never crosses.
    expect(answerFor(channel, "probe.who")).toEqual({
      seq: 1,
      value: { pname: "remote", kids: ["remote:one", "remote:two"] },
    });

    await endServer(channel, served);
  });

  it("answers two calls to the same method as they finish, each with its own seq", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.late`]: { seq: 1, args: [40] } });
    channel.handler!({ [`${REFLECT_CALL}probe.late`]: { seq: 2, args: [0] } });
    await waitUntil(
      () => channel.sent.filter((f) => frameKey(f, REFLECT_RESULT)).length === 2,
      "both answers",
    );
    const answers = channel.sent
      .filter((f) => frameKey(f, REFLECT_RESULT))
      .map((f) => f[frameKey(f, REFLECT_RESULT)!] as Record<string, unknown>);
    expect(answers).toEqual([
      { seq: 2, value: "late:0" },
      { seq: 1, value: "late:40" },
    ]);

    await endServer(channel, served);
  });

  it("refuses a name it never announced", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.nope`]: { seq: 3, args: [] } });
    await waitUntil(() => answerFor(channel, "probe.nope") !== undefined, "the refusal");
    expect(answerFor(channel, "probe.nope")).toEqual({
      seq: 3,
      error: "no reflection method named probe.nope",
    });

    await endServer(channel, served);
  });

  it("carries a method's own failure back as the reason", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.boom`]: { seq: 4, args: [] } });
    await waitUntil(() => answerFor(channel, "probe.boom") !== undefined, "the refusal");
    expect(answerFor(channel, "probe.boom")).toEqual({ seq: 4, error: "probe said no" });

    await endServer(channel, served);
  });

  it("answers with a reference where a process cannot be written down", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.child`]: { seq: 8, args: [] } });
    channel.handler!({ [`${REFLECT_CALL}probe.children`]: { seq: 9, args: [] } });
    await waitUntil(() => answersFor(channel, "probe.children").length === 1, "both answers");

    expect(answersFor(channel, "probe.child")).toEqual([
      { seq: 8, value: { [PROCESS_REF]: { id: 2, pname: "remote:one" } } },
    ]);
    // The same process handed over again is the same reference; the second child
    // is a different process, so it gets an id of its own.
    expect(answersFor(channel, "probe.children")).toEqual([
      {
        seq: 9,
        value: [
          { [PROCESS_REF]: { id: 2, pname: "remote:one" } },
          { [PROCESS_REF]: { id: 4, pname: "remote:two" } },
        ],
      },
    ]);

    await endServer(channel, served);
  });

  it("delivers a message to the root the frame is addressed to", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ to: ROOT_ID, $msg: { fromName: "root", body: { type: "STOP" } } });
    await served;
  });

  it("drops a message addressed to a process this connection does not hold", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ to: 99, $msg: { fromName: "root", body: { type: "STOP" } } });
    await sleep(10);
    expect(channel.sent.some(isExit)).toBe(false);

    await endServer(channel, served);
  });

  it("answers a call the frame addresses to the root", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.add`]: { seq: 12, args: [1, 2] }, to: ROOT_ID });
    await waitUntil(() => answerFor(channel, "probe.add") !== undefined, "the answer");
    expect(answerFor(channel, "probe.add")).toEqual({ seq: 12, value: 3 });

    await endServer(channel, served);
  });

  it("refuses a call addressed to a process this connection does not hold", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.add`]: { seq: 13, args: [1, 2] }, to: 42 });
    await waitUntil(() => answerFor(channel, "probe.add") !== undefined, "the refusal");
    expect(answerFor(channel, "probe.add")).toEqual({
      seq: 13,
      error: "no process with that id on this connection",
    });

    await endServer(channel, served);
  });

  it("carries a process on the state out as a reference", async () => {
    const { channel, served } = await serveProbe();
    const before = channel.sent.filter(isState).length;

    channel.handler!({ [`${REFLECT_CALL}probe.expose`]: { seq: 14, args: [] } });
    await waitUntil(() => channel.sent.filter(isState).length > before, "the state it set");

    // The frame that carried it, not the last one: the process it carries has a
    // state of its own, which streams as soon as it has crossed.
    const carrying = rootStates(channel).find((frame) => "child" in frame.$state);
    expect(carrying?.$state.child).toEqual({ [PROCESS_REF]: { id: 2, pname: "remote:one" } });

    await endServer(channel, served);
  });

  it("streams a process from the moment it crosses", async () => {
    const { channel, served } = await serveProbe();
    const before = channel.sent.filter(isState).length;

    channel.handler!({ [`${REFLECT_CALL}probe.expose`]: { seq: 15, args: [] } });
    await waitUntil(() => channel.sent.filter(isState).length > before, "the state it set");

    // What it can answer, then what it holds: both about the process that just
    // crossed, and both before anything else about it.
    const announced = channel.sent.filter((f) => f.to === 2 && isReflectionMethods(f));
    expect(announced.length).toBe(1);
    expect(channel.sent.some((f) => f.to === 2 && isState(f))).toBe(true);

    // From then on it is streamed like the root: a message it emits, and its state.
    channel.handler!({ to: 2, $msg: { fromName: "client", body: { type: "PING" } } });
    await waitUntil(() => channel.sent.some((f) => f.to === 2 && isMsg(f)), "its message");
    const told = channel.sent.find((f) => f.to === 2 && isMsg(f));
    expect(told?.$msg).toEqual({ fromName: "remote:one", body: { type: "PONG" } });

    await endServer(channel, served);
  });

  it("takes what the far side says about a process it handed over", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({
      [`${REFLECT_CALL}probe.take`]: { seq: 20, args: [{ [PROCESS_REF]: { id: 1, pname: "mine" } }] },
    });
    await waitUntil(() => answerFor(channel, "probe.take") !== undefined, "the handle");
    expect(answerFor(channel, "probe.take")).toEqual({ seq: 20, value: 1 });

    channel.handler!({ to: 1, $state: { pings: 1 } });
    channel.handler!({ [`${REFLECT_CALL}probe.held`]: { seq: 21, args: [] } });
    await waitUntil(() => answerFor(channel, "probe.held") !== undefined, "what it holds");
    expect(answerFor(channel, "probe.held")).toEqual({
      seq: 21,
      value: { pname: "mine", state: { pings: 1 } },
    });

    await endServer(channel, served);
  });

  it("is not told what a process of its own holds", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ to: ROOT_ID, $state: { pings: 99 } });
    channel.handler!({ [`${REFLECT_CALL}probe.stateOf`]: { seq: 22, args: [] } });
    await waitUntil(() => answerFor(channel, "probe.stateOf") !== undefined, "its own state");
    expect(answerFor(channel, "probe.stateOf")).toEqual({ seq: 22, value: { hits: 0 } });

    await endServer(channel, served);
  });

  it("reads a process that arrived inside a message as a handle", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({
      $msg: {
        fromName: "client",
        body: { type: "KEEP", kid: { [PROCESS_REF]: { id: 1, pname: "mine" } } },
      },
    });
    await waitUntil(() => channel.sent.some((f) => isState(f) && "kept" in f.$state), "the state it set");

    channel.handler!({ [`${REFLECT_CALL}probe.held`]: { seq: 23, args: [] } });
    await waitUntil(() => answerFor(channel, "probe.held") !== undefined, "what it holds");
    expect(answerFor(channel, "probe.held")).toEqual({
      seq: 23,
      value: { pname: "mine", state: null },
    });

    await endServer(channel, served);
  });

  it("stops a process it holds when the far side asks, and says that it ended", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.expose`]: { seq: 40, args: [] } });
    await waitUntil(() => rootStates(channel).some((f) => "child" in f.$state), "the child it put out");

    channel.handler!({ to: 2, $stop: {} });
    await waitUntil(() => channel.sent.some((f) => f.to === 2 && isExit(f)), "its exit");
    expect(channel.sent.find((f) => f.to === 2 && isExit(f))?.$exit).toEqual({ code: 0, state: null });

    await endServer(channel, served);
  });

  it("forgets a process it holds when the far side lets it go, and is not asked of it again", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.expose`]: { seq: 42, args: [] } });
    await waitUntil(() => rootStates(channel).some((f) => "child" in f.$state), "the child it put out");
    await waitUntil(() => channel.sent.some((f) => f.to === 2 && isState(f)), "its stream");

    channel.handler!({ to: 2, $release: {} });
    await sleep(10);
    channel.sent.length = 0;

    // The id is no longer this connection's: a call to it is refused, and a message
    // to it goes nowhere.  The process itself is untouched, and nothing about it is
    // said here any more.
    channel.handler!({ [`${REFLECT_CALL}probe.add`]: { seq: 43, args: [1, 2] }, to: 2 });
    await waitUntil(() => answerFor(channel, "probe.add") !== undefined, "the refusal");
    expect(answerFor(channel, "probe.add")).toEqual({
      seq: 43,
      error: "no process with that id on this connection",
    });

    channel.handler!({ to: 2, $msg: { fromName: "client", body: { type: "PING" } } });
    await sleep(20);
    expect(channel.sent.filter((f) => f.to === 2)).toEqual([]);

    await endServer(channel, served);
  });

  it("leaves a process it holds alone when the far side only pauses it", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.expose`]: { seq: 41, args: [] } });
    await waitUntil(() => rootStates(channel).some((f) => "child" in f.$state), "the child it put out");

    channel.handler!({ to: 2, $pause: {} });
    channel.handler!({ to: 2, $msg: { fromName: "client", body: { type: "PING" } } });
    await sleep(20);
    expect(channel.sent.some((f) => f.to === 2 && isMsg(f))).toBe(false);

    channel.handler!({ to: 2, $resume: {} });
    await waitUntil(() => channel.sent.some((f) => f.to === 2 && isMsg(f)), "its answer");

    await endServer(channel, served);
  });

  it("carries a process of its own inside a message out as a reference", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.sendChild`]: { seq: 24, args: [] } });
    await waitUntil(() => channel.sent.some(isMsg), "the message it sent");

    const sent = channel.sent.find(isMsg);
    expect(sent?.$msg.body).toEqual({
      type: "KID",
      kid: { [PROCESS_REF]: { id: 2, pname: "remote:one" } },
    });

    await endServer(channel, served);
  });

  it("carries the process the state replaced another with", async () => {
    const { channel, served } = await serveProbe();
    const carried = () => rootStates(channel).filter((frame) => "child" in frame.$state);

    channel.handler!({ [`${REFLECT_CALL}probe.expose`]: { seq: 25, args: [] } });
    await waitUntil(() => carried().length > 0, "the first one");
    channel.handler!({ [`${REFLECT_CALL}probe.swap`]: { seq: 26, args: [] } });
    await waitUntil(() => carried().length > 1, "the one that replaced it");

    // Two processes, two ids: what the state holds now is not what it held.
    expect(carried()[0].$state.child).toEqual({ [PROCESS_REF]: { id: 2, pname: "remote:one" } });
    expect(carried()[1].$state.child).toEqual({ [PROCESS_REF]: { id: 4, pname: "remote:two" } });

    await endServer(channel, served);
  });

  it("parses a reference that arrived as an argument", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({
      [`${REFLECT_CALL}probe.whatItGot`]: {
        seq: 11,
        args: [{ [PROCESS_REF]: { id: 4, pname: "tools:kid" } }],
      },
    });
    await waitUntil(() => answerFor(channel, "probe.whatItGot") !== undefined, "the answer");
    expect(answerFor(channel, "probe.whatItGot")).toEqual({
      seq: 11,
      value: { reference: "tools:kid", id: 4 },
    });

    await endServer(channel, served);
  });

  it("hands a reference back to its holder as the process itself", async () => {
    const { channel, served } = await serveProbe();

    // Hand the child over first: that is when it gets an id here.
    channel.handler!({ [`${REFLECT_CALL}probe.child`]: { seq: 15, args: [] } });
    await waitUntil(() => answerFor(channel, "probe.child") !== undefined, "the reference");

    // Id 2 is this side's own child, so a reference to it is not something to
    // make a handle of: it is the process, back where it belongs.
    channel.handler!({
      [`${REFLECT_CALL}probe.whatItGot`]: { seq: 16, args: [{ [PROCESS_REF]: { id: 2, pname: "remote:one" } }] },
    });
    await waitUntil(() => answerFor(channel, "probe.whatItGot") !== undefined, "the answer");
    expect(answerFor(channel, "probe.whatItGot")).toEqual({ seq: 16, value: { plain: true } });

    await endServer(channel, served);
  });

  it("refuses a result that cannot cross a frame", async () => {
    const { channel, served } = await serveProbe();

    channel.handler!({ [`${REFLECT_CALL}probe.refusing`]: { seq: 5, args: [] } });
    await waitUntil(() => answerFor(channel, "probe.refusing") !== undefined, "the refusal");
    expect(answerFor(channel, "probe.refusing")).toMatchObject({
      seq: 5,
      error: "probe.refusing returned a function, which cannot cross a frame",
    });

    await endServer(channel, served);
  });
});

// ── the frames themselves ──────────────────────────────────────────────────

describe("reflection frames", () => {
  it("reads a call and an answer, and leaves other frames alone", () => {
    expect(asReflectionCall({ [`${REFLECT_CALL}probe.add`]: { seq: 2, args: [1, 2] } })).toEqual({
      name: "probe.add",
      seq: 2,
      args: [1, 2],
    });
    expect(asReflectionCall({ [REFLECT_CALL]: { seq: 1 } })).toBeNull();
    expect(asReflectionCall({ [`${REFLECT_CALL}probe.add`]: { args: [] } })).toBeNull();
    expect(asReflectionCall({ $msg: { fromName: "x", body: { type: "PING" } } })).toBeNull();

    expect(asReflectionResult({ [`${REFLECT_RESULT}probe.add`]: { seq: 2, value: 3 } })).toEqual({
      name: "probe.add",
      seq: 2,
      value: 3,
    });
    expect(
      asReflectionResult({ [`${REFLECT_RESULT}probe.add`]: { seq: 2, error: "no" } }),
    ).toEqual({ name: "probe.add", seq: 2, error: "no" });
    expect(asReflectionResult({ [`${REFLECT_RESULT}probe.add`]: { value: 3 } })).toBeNull();
  });

  it("knows which values can cross a frame", () => {
    expect(jsonProblem(42)).toBeNull();
    expect(jsonProblem("text")).toBeNull();
    expect(jsonProblem(null)).toBeNull();
    expect(jsonProblem({ nested: [1, "two", false] })).toBeNull();

    expect(jsonProblem(() => 1)).toBe("a function");
    expect(jsonProblem(Symbol("s"))).toBe("a symbol");
    expect(jsonProblem(BigInt(10))).toBe("a bigint");

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(jsonProblem(cycle)).toMatch(/circular|cyclic/);
  });
});
