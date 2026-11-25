// ── a registered process on a node, as an actor here ────────────────────────
//
// The cluster is a double: what the proxy writes is what the far side reads, and what the far side writes is what the
// proxy is handed. One connection, several pids — which is what the routing case is for.

import { afterEach, describe, expect, it, vi } from "vitest";

import { memoryChannelPair } from "posipaki/port";

import { forgetCluster, installCluster, nodeRef, type Cluster, type NodeRef, type PidTerm } from "./cluster.js";
import type { WireMessage } from "./messages.js";
import { ErlangProxy, type EtfRaw } from "./proxy.js";
import { reference, type Term } from "./terms.js";

const CLUSTER = "test";
const REF: NodeRef = nodeRef("robot", "192.168.88.20", CLUSTER);
const PID: PidTerm = { kind: "pid", node: "probe@192.168.88.27", id: 1, serial: 0, creation: 7 };
const OTHER: PidTerm = { ...PID, id: 2 };

/** A cluster whose one node is a memory pair, with one address per proxy. */
function fakeCluster() {
  const pair = memoryChannelPair<WireMessage>();
  const written: WireMessage[] = [];
  const closed: string[] = [];
  let next = 1;
  const cluster: Cluster = {
    name: CLUSTER,
    channel: async () => pair.near,
    pidOf: (): PidTerm => ({ ...PID, id: next++ }),
    processOf: () => null,
    send: async () => undefined,
    // The double answers no watches: a promise that never settles is a peer that never ends anything.
    watch: () => new Promise<Term>(() => undefined),
    watchName: () => new Promise<Term>(() => undefined),
    adopt: () => undefined,
    // This double is a cluster a test addresses, not one that serves: nothing asks it for a node.
    node: async () => {
      throw new Error("a double starts no node");
    },
    close: async () => undefined,
  };
  pair.far.onFrame((said: WireMessage) => written.push(said));
  pair.far.onClose((reason: string) => closed.push(reason));
  installCluster(cluster);
  return { cluster, written, closed, far: pair.far };
}

const atomOf = (name: string): Term => ({ kind: "atom", name });
const say = (body: Term): EtfRaw => ({ type: "ETF_RAW", body });

/** A proxy and everything it emitted. */
async function proxyOf(processName = "relay") {
  const out: EtfRaw[] = [];
  const proxy = await ErlangProxy.spawn(
    { node: REF, processName },
    { toParent: (message: EtfRaw) => out.push(message) },
  );
  opened.push(proxy);
  return { proxy, out };
}

/** A moment for the frames to cross. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

const opened: Array<{ stop(): Promise<unknown> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const proxy of opened.splice(0)) await proxy.stop().catch(() => undefined);
  forgetCluster(CLUSTER);
});

describe("ErlangProxy", () => {
  it("carries a term to the name it was forked with", async () => {
    const { written } = fakeCluster();
    const { proxy } = await proxyOf();
    proxy.send(say(atomOf("hi")));
    await settle();
    expect(written).toHaveLength(1);
    const first = written[0];
    expect(first?.kind).toBe("message");
    if (first?.kind !== "message") return;
    expect(first.control).toEqual({ kind: "regSend", from: PID, to: "relay" });
    expect(first.payload).toEqual(atomOf("hi"));
  });

  it("brings what the node addressed to its pid back out", async () => {
    const { far } = fakeCluster();
    const { out } = await proxyOf();
    await far.send({ kind: "message", control: { kind: "send", to: PID }, payload: atomOf("pong") });
    await settle();
    expect(out).toEqual([{ type: "ETF_RAW", body: atomOf("pong") }]);
  });

  it("says nothing about a message for another pid on the same connection", async () => {
    const { far } = fakeCluster();
    const { out } = await proxyOf();
    await far.send({ kind: "message", control: { kind: "send", to: OTHER }, payload: atomOf("not mine") });
    await settle();
    expect(out).toEqual([]);
  });

  it("ends when the connection does", async () => {
    const { far } = fakeCluster();
    const { proxy } = await proxyOf();
    let ended = false;
    void proxy.wait().then(() => {
      ended = true;
    });
    await settle();
    expect(ended).toBe(false);
    await far.close("the far end closed");
    await settle();
    expect(ended).toBe(true);
  });

  it("publishes the pid it answers at", async () => {
    fakeCluster();
    const { proxy } = await proxyOf();
    expect(proxy.state?.erlangPid).toEqual(PID);
  });

  it("carries a reference a peer gave it, as the octets it arrived as", async () => {
    const { written } = fakeCluster();
    const { proxy } = await proxyOf();
    // A reference is not this side's to mint: what goes out is what a node sent it, byte for byte.
    proxy.send(say(reference("robot@192.168.88.20", 9)));
    await settle();
    expect(written).toHaveLength(1);
    const said = written[0];
    expect(said.kind === "message" ? said.payload?.kind : null).toBe("ref");
  });

  it("says which clusters exist when the reference names one there is not", async () => {
    await expect(
      ErlangProxy.spawn({ node: nodeRef("robot", "192.168.88.20", "nowhere"), processName: "relay" }),
    ).rejects.toThrow(/there is no cluster called nowhere/);
  });
});
