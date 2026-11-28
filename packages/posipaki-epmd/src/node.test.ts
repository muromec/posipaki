// ── a node, from this side ──────────────────────────────────────────────────
//
// A node on a real socket and a peer on the other end of it: the handshake, the frames, the control message, and one
// process served under a name and under the pid this node minted for it. Nothing here is a double but the process.

import { afterEach, describe, expect, it, vi } from "vitest";

import { defineActor, defineMessages } from "posipaki";
import type { Channel } from "posipaki/port";

import { makeCluster, nodeRef } from "./cluster.js";
import { open } from "./connection.js";
import { listen } from "./listen.js";
import type { WireMessage } from "./messages.js";
import { forgetNode, nodeNamed, startNode, type ErlangNode, type EtfTerm } from "./node.js";
import { processTerm, show, type ErlangProcess, type VisibleTerm } from "./processes.js";
import { atom, binary, pid, reference, tuple } from "./terms.js";

const CLUSTER = "node-test";
const COOKIE = "pocookie";
const SELF = "probe@127.0.0.1";
const PEER = "robot@127.0.0.1";
const PEER_PID = pid(PEER, 42, 0, 9);

/** What the served process heard, in the order it heard it. */
const heard: EtfTerm[] = [];
const heardArrived = arriving(heard);

/** The process a term names, if it names one: `{Pid, …}` is how a peer says who to answer. */
function namedIn(body: VisibleTerm): ErlangProcess | undefined {
  if (body.kind !== "tuple") return undefined;
  const first = body.items[0];
  return first?.kind === "remote" ? first.process : undefined;
}

/** The process the term names, if it names one: the first item of `{Pid, …}`. */
const Answerer = defineActor({
  name: "answerer",
  inMessages: defineMessages<EtfTerm>(),
  outMessages: defineMessages<never>(),
  handlers: {
    async ETF_RAW(asked: EtfTerm) {
      heard.push(asked);
      heardArrived.wake();
      const to = namedIn(asked.body);
      if (to === undefined) return;
      // An answer is a send of the actor's own, to the process the term names: nothing emits.
      await to.send(tuple(processTerm(this.self), binary(Buffer.from("done", "utf8"))));
    },
  },
});

/** Throws on every term it is given: what a peer sees when a served process dies of an error. */
const Crasher = defineActor({
  name: "crasher",
  inMessages: defineMessages<EtfTerm>(),
  outMessages: defineMessages<never>(),
  handlers: {
    ETF_RAW() {
      throw new Error("the handler gave up");
    },
  },
});

/** A node listening on a port nobody knows, and a peer connected to it. */
interface Serving {
  readonly node: ErlangNode;
  readonly answerer: Awaited<ReturnType<typeof Answerer.spawn>>;
  readonly peer: Channel<WireMessage>;
  readonly frames: WireMessage[];
  readonly arrived: { wake(): void; reach(count: number): Promise<void>; when(found: () => boolean): Promise<void> };
}

const running: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  heard.length = 0;
  // Last started, first stopped: the reverse of the order the case started them in.
  const stops = running.splice(0);
  for (let index = stops.length - 1; index >= 0; index -= 1) await stops[index]?.().catch(() => undefined);
  forgetNode(CLUSTER);
});

/** A node on loopback: told where it answers and where it listens, and registered nowhere. */
function starting(): Promise<ErlangNode> {
  return startNode({
    clusterName: CLUSTER,
    self: SELF,
    cookie: COOKIE,
    register: false,
    host: "127.0.0.1",
    port: 0,
  });
}

async function serving(): Promise<Serving> {
  // The node is only asked where to listen: a test names the port itself and leaves the box's mapper out of it.
  const node = await starting();
  const answerer = await Answerer.spawn(undefined);
  node.registerProcess("answer", answerer);
  const opened = await open(node.port, { host: "127.0.0.1", node: "probe", cookie: COOKIE, self: PEER, creation: 9 });
  const frames: WireMessage[] = [];
  const arrived = arriving(frames);
  opened.messages.onFrame((said) => {
    frames.push(said);
    arrived.wake();
  });
  running.push(async () => node.close());
  running.push(async () => answerer.stop());
  return { node, answerer, peer: opened.messages, frames, arrived };
}

/** Waits until a list has what the case expects, without reading a clock. */
function arriving<T>(items: T[]) {
  let woken: Array<() => void> = [];
  return {
    wake(): void {
      for (const call of woken.splice(0)) call();
    },
    async reach(count: number): Promise<void> {
      while (items.length < count) await new Promise<void>((call) => woken.push(call));
    },
    /** Waits until one of the items satisfies `found`, re-checked on every arrival. */
    async when(found: () => boolean): Promise<void> {
      while (!found()) await new Promise<void>((call) => woken.push(call));
    },
  };
}

describe("a node", () => {
  it("hands a term addressed to a served name to its process, with the asker as a reference", async () => {
    const { peer } = await serving();
    await peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: tuple(PEER_PID, binary(Buffer.from("hi", "utf8"))),
    });
    await heardArrived.reach(1);

    const asked = heard[0];
    expect(asked?.type).toBe("ETF_RAW");
    // And the pid the term carried is a reference, not an address the process has to spell out.
    expect(namedIn(asked?.body ?? atom(""))?.pid).toEqual(PEER_PID);
  });

  it("sends an answer back over the connection it arrived on, to the pid the term named", async () => {
    const { peer, frames, arrived } = await serving();
    await peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: tuple(PEER_PID, binary(Buffer.from("hi", "utf8"))),
    });
    await arrived.reach(1);

    const answer = frames[0];
    expect(answer?.kind).toBe("message");
    if (answer?.kind !== "message") return;
    expect(answer.control.kind === "send" && answer.control.to).toEqual(PEER_PID);
    // The answering process is written as an address of this node, and its own word is in the term.
    expect(answer.payload === null ? "" : show(answer.payload)).toContain("done");
    expect(answer.payload === null ? "" : show(answer.payload)).toContain(SELF);
  });

  it("reaches the same process by the pid the cluster minted for it, and that send carries no sender", async () => {
    const { node, answerer, peer, frames, arrived } = await serving();
    const address = node.pidOf(answerer);
    await peer.send({
      kind: "message",
      control: { kind: "send", to: address },
      payload: tuple(PEER_PID, binary(Buffer.from("hi", "utf8"))),
    });
    await arrived.reach(1);

    // A send control has no sender field: the term is the only way back, and the process is told none was given.
    expect(heard[0]?.body.kind).toBe("tuple");
  });

  it("says an address serves nobody here, and keeps the connection", async () => {
    const { peer, frames, arrived } = await serving();
    let said: () => void = () => undefined;
    const complainedOnce = new Promise<void>((resolve) => {
      said = resolve;
    });
    const complained = vi.spyOn(console, "error").mockImplementation(() => said());
    await peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "nobody" },
      payload: atom("hi"),
    });
    await complainedOnce;
    expect(String(complained.mock.calls[0]?.[0])).toContain("which serves nobody here");

    // The same connection still answers.
    await peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: tuple(PEER_PID, atom("hi")),
    });
    await arrived.reach(1);
  });

  it("stops serving a process that ends", async () => {
    const { answerer, peer } = await serving();
    let said: () => void = () => undefined;
    const complainedOnce = new Promise<void>((resolve) => {
      said = resolve;
    });
    const complained = vi.spyOn(console, "error").mockImplementation((...written: unknown[]) => {
      if (String(written[0]).includes("serves nobody here")) said();
    });
    await answerer.stop();
    await peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: atom("hi"),
    });
    await complainedOnce;
    expect(heard).toHaveLength(0);
  });

  it("refuses a name it already serves with another process", async () => {
    const { node } = await serving();
    const other = await Answerer.spawn(undefined);
    running.push(async () => other.stop());
    expect(() => node.registerProcess("answer", other)).toThrow(/already serves answer/);
  });

  it("runs one node per cluster name: two would mint the same pids", async () => {
    await serving();
    await expect(starting()).rejects.toThrow(/already runs a node/);
  });

  it("binds a node to a cluster nobody configured, and is found there by that name", async () => {
    // No `makeCluster`: a name nothing was installed under is the defaults, and the node is its slot.
    const node = await startNode({
      clusterName: "unheard-of",
      self: SELF,
      cookie: COOKIE,
      register: false,
      host: "127.0.0.1",
      port: 0,
    });
    running.push(async () => node.close());
    expect(nodeNamed("unheard-of")).toBe(node);
    await node.close();
    expect(() => nodeNamed("unheard-of")).toThrow(/no node running as unheard-of/);
  });

  it("stops listening when it is closed", async () => {
    const node = await starting();
    const port = node.port;
    await node.close();
    await expect(open(port, { host: "127.0.0.1", node: "probe", cookie: COOKIE, self: PEER, creation: 9 })).rejects.toThrow();
  });

  /** A term the served process answers, so a frame that came before it is known to have been read. */
  const beat = (peer: Channel<WireMessage>): Promise<void> =>
    peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: tuple(PEER_PID, atom("still here")),
    });

  it("reports a watched process's end to the pid that asked, with the ref it minted", async () => {
    const { node, answerer, peer, frames, arrived } = await serving();
    const address = node.pidOf(answerer);
    const ref = reference(PEER, 9);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: address, ref }, payload: null });
    // Frames on one connection are read in the order they arrive, so an answer proves the watch was recorded.
    await beat(peer);
    await arrived.reach(1);
    await answerer.stop();
    await arrived.reach(2);

    expect(frames[1]?.kind === "message" && frames[1].control).toEqual({
      kind: "monitorExit",
      from: address,
      to: PEER_PID,
      ref,
      reason: atom("normal"),
    });
  });

  it("answers a watch set on a name with that name, not the pid it resolved to", async () => {
    const { answerer, peer, frames, arrived } = await serving();
    const ref = reference(PEER, 10);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: atom("answer"), ref }, payload: null });
    await beat(peer);
    await arrived.reach(1);
    await answerer.stop();
    await arrived.reach(2);

    // A name is what the peer matched this answer against, so a name is what comes back.
    expect(frames[1]?.kind === "message" && frames[1].control).toEqual({
      kind: "monitorExit",
      from: atom("answer"),
      to: PEER_PID,
      ref,
      reason: atom("normal"),
    });
  });

  it("answers noproc at once for an address that serves nobody, and keeps the connection", async () => {
    const { peer, frames, arrived } = await serving();
    const ref = reference(PEER, 11);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: atom("nobody"), ref }, payload: null });
    await arrived.reach(1);

    expect(frames[0]?.kind === "message" && frames[0].control).toEqual({
      kind: "monitorExit",
      from: atom("nobody"),
      to: PEER_PID,
      ref,
      reason: atom("noproc"),
    });

    // The connection is still the peer's: an address nobody answers says nothing about the wire.
    await beat(peer);
    await heardArrived.reach(1);
  });

  it("forgets a watch the peer cancelled: the process ends and nothing is said about it", async () => {
    const { node, answerer, peer, frames, arrived } = await serving();
    const address = node.pidOf(answerer);
    const ref = reference(PEER, 12);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: address, ref }, payload: null });
    await beat(peer);
    await arrived.reach(1);
    await peer.send({ kind: "message", control: { kind: "demonitor", from: PEER_PID, to: address, ref }, payload: null });
    await beat(peer);
    await arrived.reach(2);
    await answerer.stop();
    // A watch set on the same address now is answered `noproc` at once: that frame proves the node has worked through
    // what came before it, so a monitor-exit for the cancelled ref would already have been written.
    const later = reference(PEER, 13);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: address, ref: later }, payload: null });
    await arrived.reach(3);
    // The only thing said afterwards is that answer, and it names the new ref: the cancelled one heard nothing.
    expect(frames).toHaveLength(3);
    const answered = frames[2];
    expect(answered?.kind === "message" && answered.control).toEqual({
      kind: "monitorExit",
      from: address,
      to: PEER_PID,
      ref: later,
      reason: atom("noproc"),
    });
  });

  it("lets the ending it reported finish before the connection it goes over is let go", async () => {
    const { node, answerer, peer, frames, arrived } = await serving();
    const address = node.pidOf(answerer);
    const ref = reference(PEER, 13);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: address, ref }, payload: null });
    await beat(peer);
    await arrived.reach(1);
    // The end and the close happen in one turn: the peer that watched the process reads why it ended, and
    // `noconnection` would be a different fact.
    await answerer.stop();
    await node.close();
    expect(frames).toHaveLength(2);
  });

  it("answers a watch with the failure a process died of, not with normal", async () => {
    const { node, peer, frames, arrived } = await serving();
    const crasher = await Crasher.spawn(undefined);
    node.registerProcess("crash", crasher);
    running.push(async () => crasher.stop());
    const address = node.pidOf(crasher);
    const ref = reference(PEER, 14);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: address, ref }, payload: null });
    await beat(peer);
    await arrived.reach(1);

    // A send carries no sender, and that is all this needs: the term is what makes the handler throw.
    await peer.send({ kind: "message", control: { kind: "send", to: address }, payload: atom("boom") });
    await arrived.reach(2);

    expect(frames[1]?.kind === "message" && frames[1].control).toEqual({
      kind: "monitorExit",
      from: address,
      to: PEER_PID,
      ref,
      reason: tuple(atom("error"), binary(Buffer.from("the handler gave up", "utf8"))),
    });
  });

  it("ends a process here when the other end of a link says it ended", async () => {
    const { node, answerer, peer } = await serving();
    const address = node.pidOf(answerer);
    await peer.send({ kind: "message", control: { kind: "link", from: PEER_PID, to: address }, payload: null });
    await peer.send({
      kind: "message",
      control: { kind: "exit", from: PEER_PID, to: address, reason: atom("kill") },
      payload: null,
    });

    // A link takes both ends: the process is over, and this would time out if it were not.
    await answerer.wait();
  });

  it("leaves a process alone when the other end of a link ended normally", async () => {
    const { node, answerer, peer, frames, arrived } = await serving();
    const address = node.pidOf(answerer);
    await peer.send({ kind: "message", control: { kind: "link", from: PEER_PID, to: address }, payload: null });
    await peer.send({
      kind: "message",
      control: { kind: "exit", from: PEER_PID, to: address, reason: atom("normal") },
      payload: null,
    });

    // The process still answers, which is what a normal end at the other end of a link owes: nothing.
    await beat(peer);
    await arrived.reach(1);
  });

  it("tells the other end of a link when a process here ends", async () => {
    const { node, answerer, frames, arrived } = await serving();
    const address = node.pidOf(answerer);
    await node.link(address, PEER_PID);

    await answerer.stop();
    // The peer hears the link was made, and then that this end is over: a link ends both.
    await arrived.when(() => frames.some((said) => said.kind === "message" && said.control.kind === "exit"));

    const ended = frames.find((said) => said.kind === "message" && said.control.kind === "exit");
    expect(ended?.kind === "message" && ended.control).toEqual({
      kind: "exit",
      from: address,
      to: PEER_PID,
      reason: atom("normal"),
    });
  });

  it("sends a term to a pid, and to a name with the sender the wire wants for that shape", async () => {
    const { node, answerer, frames, arrived } = await serving();
    const address = pid(PEER, 77, 0, 9);
    await node.send(address, atom("one"));
    await node.sendReg("answer", nodeRef("robot", "127.0.0.1", CLUSTER), atom("two"), answerer);

    await arrived.reach(2);
    expect(frames[0]?.kind === "message" && frames[0].control).toEqual({ kind: "send", to: address });
    const toName = frames[1];
    expect(toName?.kind === "message" && toName.control.kind === "regSend" && toName.control.to).toBe("answer");
    // The sender the wire carries is the process that asked, by its pid on this node.
    expect(toName?.kind === "message" && toName.control.kind === "regSend" && toName.control.from).toEqual(
      node.pidOf(answerer),
    );
  });
});
