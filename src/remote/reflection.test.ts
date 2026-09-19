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
  isReflectionMethods,
  isState,
  jsonProblem,
} from "./channel.js";
import type { Channel } from "./channel.js";
import { PROCESS_REF, ROOT_ID, ProcessTable, UnreachableRemoteProcess } from "./process-ref.js";
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

describe("remoteClient process references", () => {
  it("parses a reference into a process it cannot reach", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.child"]);

    const answer = surface["probe.child"]!();
    channel.handler!({
      [`${REFLECT_RESULT}probe.child`]: { seq: 1, value: { [PROCESS_REF]: { id: 4, pname: "tools:kid" } } },
    });

    const found = await answer;
    expect(found).toBeInstanceOf(UnreachableRemoteProcess);
    expect((found as UnreachableRemoteProcess).id).toBe(4);
    expect((found as UnreachableRemoteProcess).pname).toBe("tools:kid");

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

    const value = (await answer) as { kids: UnreachableRemoteProcess[] };
    expect(value.kids[0]).toBeInstanceOf(UnreachableRemoteProcess);

    await endProxy(channel, proc);
  });

  it("writes a reference back into the frame, with the id it came with", async () => {
    const { channel, proc, surface } = await spawnProxy(["probe.use"]);

    const ref = new UnreachableRemoteProcess({ id: 4, pname: "tools:kid" });
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
    const table = new ProcessTable();

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
    const frame = decodeFrame({
      $msg: { fromName: "far", body: { kid: { [PROCESS_REF]: { id: 4, pname: "theirs" } } } },
    });
    const kid = (frame.$msg as { body: { kid: UnreachableRemoteProcess } }).body.kid;

    expect(kid).toBeInstanceOf(UnreachableRemoteProcess);
    expect(kid.id).toBe(4);
    expect(kid.pname).toBe("theirs");
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

const Leaf = defineActor({ name: "leaf", plugins: [], handlers: {} });

function makeProbe() {
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
        return value instanceof UnreachableRemoteProcess
          ? { reference: value.pname, id: value.id }
          : { plain: true };
      },
    },
    async setup() {
      await this.fork(Leaf, undefined, { name: "one" });
      await this.fork(Leaf, undefined, { name: "two" });
      return { hits: 0 };
    },
    handlers: {},
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
      { seq: 8, value: { [PROCESS_REF]: { id: 1, pname: "remote:one" } } },
    ]);
    // The same process handed over again is the same reference; the second child
    // is a different process, so it gets an id of its own.
    expect(answersFor(channel, "probe.children")).toEqual([
      {
        seq: 9,
        value: [
          { [PROCESS_REF]: { id: 1, pname: "remote:one" } },
          { [PROCESS_REF]: { id: 2, pname: "remote:two" } },
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

    const states = channel.sent.filter(isState);
    const state = states[states.length - 1].$state;
    expect(state.child).toEqual({ [PROCESS_REF]: { id: 1, pname: "remote:one" } });

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
