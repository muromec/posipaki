// ── a process on another node, as an actor ─────────────────────────────────
//
// The node is a double: it records what was sent and what it was asked to start, and mints an address per process. The
// three makers are the same body with the address arriving in three places, so the cases differ only in where it is.

import { afterEach, describe, expect, it } from "vitest";

import { makeErlangConnect, makeErlangFactory, makeErlangRef } from "./actor.js";
import { nodeRef, type NodeRef, type PidTerm } from "./cluster.js";
import { forgetNode, installNode, type Reach } from "./node.js";
import { processAt, type ErlangProcess, type Start } from "./processes.js";
import { atom, binary, type Term } from "./terms.js";

const REF: NodeRef = nodeRef("robot", "192.168.88.20");
const OUR_PID: PidTerm = { kind: "pid", node: "posipaki@127.0.0.1", id: 1, serial: 0, creation: 7 };
const THEIR_PID: PidTerm = { kind: "pid", node: "robot@192.168.88.20", id: 77, serial: 0, creation: 5 };

/** A node that records what was sent to a name, what it was asked to start, and the addresses it was asked for. */
function fakeNode(ending: Promise<Term> = new Promise(() => undefined)) {
  const sent: Array<{ name: string; body: Term }> = [];
  const spawned: Start[] = [];
  /** Every process this node was asked for an address for: asking is what serves it. */
  const held: PidTerm[] = [];
  const pids = new Map<symbol, PidTerm>();
  const reach: Reach = {
    pidOf: (process) => {
      const known = pids.get(process.id);
      if (known !== undefined) return known;
      const minted: PidTerm = { ...OUR_PID, id: pids.size + 10 };
      pids.set(process.id, minted);
      held.push(minted);
      return minted;
    },
    processOf: () => null,
    send: async () => undefined,
    sendReg: async (name: string, _ref: NodeRef, body: Term) => {
      sent.push({ name, body });
    },
    watch: () => new Promise(() => undefined),
    watchName: () => Promise.resolve({ ended: ending, cancel: () => undefined }),
    kill: async () => undefined,
    link: async () => undefined,
    spawn: async (_ref: NodeRef, call) => {
      spawned.push(call);
      return processAt(THEIR_PID, reach);
    },
  };
  installNode(reach, REF.cluster);
  return { sent, spawned, held };
}

const opened: ErlangProcess["wait"] extends never ? never : Array<{ stop(): Promise<unknown> }> = [];

afterEach(async () => {
  for (const actor of opened.splice(0)) await actor.stop().catch(() => undefined);
  forgetNode(REF.cluster);
});

describe("a process on another node, as an actor", () => {
  it("writes what it is given to the name it was built for", async () => {
    const { sent } = fakeNode();
    const peer = await makeErlangRef({ node: REF, process: "relay" }).spawn(undefined);
    opened.push(peer);

    await peer.send({ type: "ETF_RAW", body: atom("hi") });
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("relay");
    expect(sent[0]?.body).toEqual(atom("hi"));
  });

  it("takes the address from its args when it is made as a connect actor", async () => {
    const { sent } = fakeNode();
    const peer = await makeErlangConnect().spawn({ node: REF, process: "watcher" });
    opened.push(peer);

    await peer.send({ type: "ETF_RAW", body: binary(Buffer.from("ping", "utf8")) });
    await tick();

    expect(sent.map((one) => one.name)).toEqual(["watcher"]);
  });

  it("is served at an address of this side, so a term carrying it comes back here", async () => {
    const { held } = fakeNode();
    const peer = await makeErlangRef({ node: REF, process: "relay" }).spawn(undefined);
    opened.push(peer);

    expect(held).toHaveLength(1);
    const far = peer.state?.far;
    expect(far !== undefined && "name" in far ? far.name : null).toBe("relay");
  });

  it("ends when the process it stands for ends", async () => {
    fakeNode(Promise.resolve(atom("normal")));
    const peer = await makeErlangRef({ node: REF, process: "relay" }).spawn(undefined);
    opened.push(peer);

    let over = false;
    void peer.wait().then(() => {
      over = true;
    });
    await tick();
    expect(over).toBe(true);
  });

  it("starts a function on that node, with its fork args as the function's parameters", async () => {
    const { spawned } = fakeNode();
    const peer = await makeErlangFactory({ node: REF, module: "there", fname: "there-spawner/2" }).spawn([
      atom("one"),
      atom("two"),
    ]);
    opened.push(peer);

    expect(spawned).toEqual([{ module: "there", function: "there-spawner", args: [atom("one"), atom("two")] }]);
    const far = peer.state?.far;
    expect(far !== undefined && "pid" in far ? far.pid : null).toEqual(THEIR_PID);
  });

  it("refuses a factory whose parameters are not the arity its name states", async () => {
    fakeNode();
    await expect(
      makeErlangFactory({ node: REF, module: "there", fname: "there-spawner/2" }).spawn([atom("one")]),
    ).rejects.toThrow("takes 2 parameters, and 1 were given");
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
