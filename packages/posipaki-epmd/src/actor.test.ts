// ── a process on another node, as an actor ─────────────────────────────────
//
// A real node, with the verbs an actor asks it for spied on: what a case measures is the call the actor made and the
// address it stands for. The three makers are one body with the address arriving in three places.

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeErlangConnect, makeErlangFactory, makeErlangRef } from "./actor.js";
import { makeCluster, nodeRef, type NodeRef, type PidTerm } from "./cluster.js";
import { startNode, type ErlangNode } from "./node.js";
import { processAt, type Start } from "./processes.js";
import { atom, binary, type Term } from "./terms.js";

const REF: NodeRef = nodeRef("robot", "192.168.88.20", "actor-test");
const THEIR_PID: PidTerm = { kind: "pid", node: "robot@192.168.88.20", id: 77, serial: 0, creation: 5 };

const nodes: ErlangNode[] = [];
const actors: Array<{ stop(): Promise<unknown> }> = [];

afterEach(async () => {
  // The spies stay in place until the actors have stopped: a restored verb is a real connection, and a closing actor
  // may ask for one.
  for (const actor of actors.splice(0)) await actor.stop().catch(() => undefined);
  for (const erlang of nodes.splice(0)) await erlang.close().catch(() => undefined);
  vi.restoreAllMocks();
});

/** A node of this side, with the calls an actor makes recorded, and a promise that settles on the first of them. */
async function serving(ending: Promise<Term> = new Promise(() => undefined)) {
  const sent: Array<{ name: string; body: Term }> = [];
  const spawned: Start[] = [];
  let seenSend: () => void = () => undefined;
  let seenSpawn: () => void = () => undefined;
  const wrote = new Promise<void>((resolve) => {
    seenSend = resolve;
  });
  const started = new Promise<void>((resolve) => {
    seenSpawn = resolve;
  });
  const erlang = await startNode(
    makeCluster({ name: REF.cluster, self: "probe@192.168.88.27", cookie: "probe", creation: 7, announce: false }),
    { host: "127.0.0.1", port: 0 },
  );
  vi.spyOn(erlang, "sendReg").mockImplementation(async (name: string, _ref: NodeRef, body: Term) => {
    sent.push({ name, body });
    seenSend();
  });
  vi.spyOn(erlang, "spawn").mockImplementation(async (_ref: NodeRef, call: Start) => {
    spawned.push(call);
    seenSpawn();
    return processAt(THEIR_PID, erlang);
  });
  vi.spyOn(erlang, "watchName").mockImplementation(() => Promise.resolve({ ended: ending, cancel: () => undefined }));
  // A process over there is watched by pid, so the same stub answers both.
  vi.spyOn(erlang, "watch").mockImplementation(() => Promise.resolve({ ended: ending, cancel: () => undefined }));
  nodes.push(erlang);
  return { erlang, sent, spawned, wrote, started };
}

describe("a process on another node, as an actor", () => {
  it("writes what it is given to the name it was built for", async () => {
    const { sent, wrote } = await serving();
    const peer = await makeErlangRef({ node: REF, process: "relay" }).spawn(undefined);
    actors.push(peer);

    await peer.send({ type: "ETF_RAW", body: atom("hi") });
    await wrote;

    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("relay");
    expect(sent[0]?.body).toEqual(atom("hi"));
  });

  it("takes the address from its args when it is made as a connect actor", async () => {
    const { sent, wrote } = await serving();
    const peer = await makeErlangConnect().spawn({ node: REF, process: "watcher" });
    actors.push(peer);

    await peer.send({ type: "ETF_RAW", body: binary(Buffer.from("ping", "utf8")) });
    await wrote;

    expect(sent.map((one) => one.name)).toEqual(["watcher"]);
  });

  it("stands for the name it was built for", async () => {
    await serving();
    const peer = await makeErlangRef({ node: REF, process: "relay" }).spawn(undefined);
    actors.push(peer);

    const far = peer.state?.far;
    expect(far !== undefined && "name" in far ? far.name : null).toBe("relay");
  });

  it("ends when the process it stands for ends", async () => {
    await serving(Promise.resolve(atom("normal")));
    const peer = await makeErlangRef({ node: REF, process: "relay" }).spawn(undefined);
    actors.push(peer);

    // `wait()` settles when the actor ends, which is the trigger: no clock is read.
    await peer.wait();
  });

  it("starts a function on that node, with its fork args as the function's parameters", async () => {
    const { spawned, started } = await serving();
    const peer = await makeErlangFactory({ node: REF, module: "there", fname: "there-spawner/2" }).spawn([
      atom("one"),
      atom("two"),
    ]);
    actors.push(peer);
    await started;

    expect(spawned).toEqual([{ module: "there", function: "there-spawner", args: [atom("one"), atom("two")] }]);
    const far = peer.state?.far;
    expect(far !== undefined && "pid" in far ? far.pid : null).toEqual(THEIR_PID);
  });

  it("refuses a factory whose parameters are not the arity its name states", async () => {
    await serving();
    await expect(
      makeErlangFactory({ node: REF, module: "there", fname: "there-spawner/2" }).spawn([atom("one")]),
    ).rejects.toThrow("takes 2 parameters, and 1 were given");
  });
});
