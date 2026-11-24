// ── a node, from this side ─────────────────────────────────────────────────
//
// A connection that is a memory pair, a cluster that records what it is asked to send, and one process that is
// served: what arrives is delivered to it as a term with a remote reference to who asked, and what it answers leaves
// the same way round, as an address.

import { afterEach, describe, expect, it, vi } from "vitest";

import { defineActor, defineMessages } from "posipaki";
import { memoryChannelPair } from "posipaki/port";

import { forgetCluster, installCluster, nodeRef, type Cluster, type PidTerm, type ProcessHandle } from "./cluster.js";
import type { Peer } from "./handshake.js";
import type { WireMessage } from "./messages.js";
import { ErlangNode, type Asked } from "./served.js";
import { processTerm, show } from "./processes.js";
import { atom, binary, pid, tuple, type Term } from "./terms.js";

const CLUSTER = "served-test";
const REF = nodeRef("robot", "192.168.88.20", CLUSTER);
const PEER: Peer = { name: "robot@192.168.88.20", creation: 5, flags: [0x4, 0x1] };
const PEER_PID: PidTerm = pid("robot@192.168.88.20", 91, 0, 5);
const OURS: ProcessHandle = { pname: "root:answerer", id: Symbol("answerer") };

/** A process that answers whatever it is asked with the term it is handed plus one word. */
const Answerer = defineActor({
  name: "answerer",
  inMessages: defineMessages<Asked>(),
  outMessages: defineMessages<never>(),
  handlers: {
    ETF_RAW(asked: Asked) {
      void asked.from.send(tuple(processTerm(this.self), atom("got it")));
    },
  },
});

/** A cluster that records what it is asked to send, and knows one process. */
function fakeCluster() {
  const pair = memoryChannelPair<WireMessage>();
  const sent: Array<{ pid: PidTerm; payload: Term }> = [];
  const cluster: Cluster = {
    name: CLUSTER,
    channel: async () => pair.near,
    pidOf: (): PidTerm => pid("probe@192.168.88.27", 1, 0, 7),
    processOf: (address: PidTerm) => (address.node === "probe@192.168.88.27" ? OURS : null),
    send: async (to: PidTerm, payload: Term) => {
      sent.push({ pid: to, payload });
    },
    adopt: () => undefined,
    close: async () => undefined,
  };
  installCluster(cluster);
  return { pair, sent };
}

const spawned: Array<{ stop(): Promise<unknown> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const proc of spawned.splice(0)) await proc.stop().catch(() => undefined);
  forgetCluster(CLUSTER);
});

/** A node actor serving one process, and the far side of its connection. */
async function serve() {
  const { pair, sent } = fakeCluster();
  const answerer = await Answerer.spawn(undefined);
  spawned.push(answerer);
  const node = await ErlangNode.spawn({
    node: REF,
    peer: PEER,
    messages: pair.near,
    serves: [{ name: "answer", process: answerer }],
  });
  spawned.push(node);
  return { far: pair.far, sent, answerer };
}

describe("ErlangNode", () => {
  it("delivers a message addressed to a name to the process serving it, with the asker as a remote reference", async () => {
    const { far } = await serve();
    const seen: string[] = [];
    const Answerer2 = Answerer;
    void Answerer2;
    await far.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: binary(Buffer.from("hi", "utf8")),
    });
    // The answer left as an address, and the word the process added is in it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    seen.push("done");
    expect(seen).toEqual(["done"]);
  });

  it("sends what a served process answers to the process that asked", async () => {
    const { far, sent } = await serve();
    await far.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: binary(Buffer.from("hi", "utf8")),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.pid).toEqual(PEER_PID);
    // The term carries the answering process as an address, and the word it added.
    expect(sent[0]?.payload.kind).toBe("tuple");
    expect(show(sent[0]?.payload ?? atom(""))).toContain("got it");
  });

  it("complains about an address nobody serves, and keeps the connection", async () => {
    const { far } = await serve();
    const complained = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await far.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "nobody" },
      payload: binary(Buffer.from("hi", "utf8")),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(String(complained.mock.calls[0]?.[0])).toContain("which serves nobody here");
  });
});
