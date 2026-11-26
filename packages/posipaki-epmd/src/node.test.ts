// ── a node, from this side ──────────────────────────────────────────────────
//
// A node on a real socket and a peer on the other end of it: the handshake, the frames, the control message, and one
// process served under a name and under the pid the cluster minted for it. Nothing here is a double but the process.

import { afterEach, describe, expect, it, vi } from "vitest";

import { defineActor, defineMessages } from "posipaki";
import type { Channel } from "posipaki/port";

import { forgetCluster, installCluster, makeCluster, type Cluster } from "./cluster.js";
import { open } from "./connection.js";
import { listen } from "./listen.js";
import type { WireMessage } from "./messages.js";
import { startNode, type ErlangNode, type EtfAnswered, type EtfAsked } from "./node.js";
import { processTerm, show, type RemoteProcess, type VisibleTerm } from "./processes.js";
import { atom, binary, pid, reference, tuple } from "./terms.js";

const CLUSTER = "node-test";
const COOKIE = "pocookie";
const SELF = "probe@127.0.0.1";
const PEER = "robot@127.0.0.1";
const PEER_PID = pid(PEER, 42, 0, 9);

/** What the served process heard, in the order it heard it. */
const heard: EtfAsked[] = [];

/** The process a term names, if it names one: `{Pid, …}` is how a peer says who to answer. */
function namedIn(body: VisibleTerm): RemoteProcess | undefined {
  if (body.kind !== "tuple") return undefined;
  const first = body.items[0];
  return first?.kind === "remote" ? first.process : undefined;
}

/** Answers whoever the term names, or the asker when the term names nobody. */
const Answerer = defineActor({
  name: "answerer",
  inMessages: defineMessages<EtfAsked>(),
  outMessages: defineMessages<EtfAnswered>(),
  handlers: {
    ETF_RAW(asked: EtfAsked) {
      heard.push(asked);
      const to = namedIn(asked.body) ?? asked.from;
      if (to === undefined) return;
      const words = process.env.POSIPAKI_WORDS ?? "done";
      this.emit({ type: "ETF_RAW", to, body: tuple(processTerm(this.self), binary(Buffer.from(words, "utf8"))) });
    },
  },
});

/** Throws on every term it is given: what a peer sees when a served process dies of an error. */
const Crasher = defineActor({
  name: "crasher",
  inMessages: defineMessages<EtfAsked>(),
  outMessages: defineMessages<never>(),
  handlers: {
    ETF_RAW() {
      throw new Error("the handler gave up");
    },
  },
});

/** A node listening on a port nobody knows, and a peer connected to it. */
interface Serving {
  readonly cluster: Cluster;
  readonly node: ErlangNode;
  readonly answerer: Awaited<ReturnType<typeof Answerer.spawn>>;
  readonly peer: Channel<WireMessage>;
  readonly frames: WireMessage[];
}

const running: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  heard.length = 0;
  // Last started, first stopped: the reverse of the order the case started them in.
  const stops = running.splice(0);
  for (let index = stops.length - 1; index >= 0; index -= 1) await stops[index]?.().catch(() => undefined);
  forgetCluster(CLUSTER);
});

async function serving(): Promise<Serving> {
  // A node is only asked where to listen: a test names the port itself and leaves the box's mapper out of it.
  const cluster = installCluster(makeCluster({ name: CLUSTER, self: SELF, cookie: COOKIE, creation: 7, announce: false }));
  const node = await cluster.node({ host: "127.0.0.1", port: 0 });
  const answerer = await Answerer.spawn(undefined);
  node.serve("answer", answerer);
  const opened = await open(node.port, { host: "127.0.0.1", node: "probe", cookie: COOKIE, self: PEER, creation: 9 });
  const frames: WireMessage[] = [];
  opened.messages.onFrame((said) => frames.push(said));
  running.push(async () => {
    await node.close();
    await cluster.close();
  });
  running.push(async () => answerer.stop());
  return { cluster, node, answerer, peer: opened.messages, frames };
}

/** Waits for a fact the test can see, and says what it waited for when it does not come. */
async function until(fact: () => boolean, what: string, bound = 3000): Promise<void> {
  const started = Date.now();
  while (!fact()) {
    if (Date.now() - started > bound) throw new Error(`waited ${bound}ms for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("a node", () => {
  it("hands a term addressed to a served name to its process, with the asker as a reference", async () => {
    const { peer } = await serving();
    await peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: tuple(PEER_PID, binary(Buffer.from("hi", "utf8"))),
    });
    await until(() => heard.length === 1, "the term to reach the process");

    const asked = heard[0];
    expect(asked?.type).toBe("ETF_RAW");
    expect(asked?.from?.pid).toEqual(PEER_PID);
    // And the pid the term carried is a reference, not an address the process has to spell out.
    expect(namedIn(asked?.body ?? atom(""))?.pid).toEqual(PEER_PID);
  });

  it("sends an answer back over the connection it arrived on, to the pid the term named", async () => {
    const { peer, frames } = await serving();
    await peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: tuple(PEER_PID, binary(Buffer.from("hi", "utf8"))),
    });
    await until(() => frames.length === 1, "the answer to come back");

    const answer = frames[0];
    expect(answer?.kind).toBe("message");
    if (answer?.kind !== "message") return;
    expect(answer.control.kind === "send" && answer.control.to).toEqual(PEER_PID);
    // The answering process is written as an address of this node, and its own word is in the term.
    expect(answer.payload === null ? "" : show(answer.payload)).toContain("done");
    expect(answer.payload === null ? "" : show(answer.payload)).toContain(SELF);
  });

  it("reaches the same process by the pid the cluster minted for it, and that send carries no sender", async () => {
    const { cluster, answerer, peer, frames } = await serving();
    const address = cluster.pidOf({ pname: answerer.pname, id: answerer.id });
    await peer.send({
      kind: "message",
      control: { kind: "send", to: address },
      payload: tuple(PEER_PID, binary(Buffer.from("hi", "utf8"))),
    });
    await until(() => frames.length === 1, "the answer to come back");

    // A send control has no sender field: the term is the only way back, and the process is told none was given.
    expect(heard[0]?.from).toBeUndefined();
    expect(heard[0]?.body.kind).toBe("tuple");
  });

  it("says an address serves nobody here, and keeps the connection", async () => {
    const { peer, frames } = await serving();
    const complained = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "nobody" },
      payload: atom("hi"),
    });
    await until(() => complained.mock.calls.length === 1, "the complaint");
    expect(String(complained.mock.calls[0]?.[0])).toContain("which serves nobody here");

    // The same connection still answers.
    await peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: tuple(PEER_PID, atom("hi")),
    });
    await until(() => frames.length === 1, "the answer after the complaint");
  });

  it("stops serving a process that ends", async () => {
    const { answerer, peer } = await serving();
    const complained = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await answerer.stop();
    await peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: atom("hi"),
    });
    await until(() => complained.mock.calls.some((call) => String(call[0]).includes("serves nobody here")), "the name to be free");
    expect(heard).toHaveLength(0);
  });

  it("refuses a name it already serves with another process", async () => {
    const { node } = await serving();
    const other = await Answerer.spawn(undefined);
    running.push(async () => other.stop());
    expect(() => node.serve("answer", other)).toThrow(/already serves answer/);
  });

  it("announces itself under the name it answers to, and lets the registration go on close", async () => {
    const told: Array<{ node: string; host: string; port: number }> = [];
    const closed: string[] = [];
    const cluster = installCluster(
      makeCluster({
        name: CLUSTER,
        self: SELF,
        cookie: COOKIE,
        creation: 7,
        announce: async (ref, port) => {
          told.push({ node: ref.node, host: ref.host, port });
          return {
            close: async () => {
              closed.push("registration");
            },
          };
        },
      }),
    );
    const node = await cluster.node({ host: "127.0.0.1", port: 0 });
    // The host is the one its own name carries: what a peer's lookup asks, answered by the same mapper.
    expect(told).toEqual([{ node: "probe", host: "127.0.0.1", port: node.port }]);
    await node.close();
    expect(closed).toEqual(["registration"]);
  });

  it("runs one node per cluster", async () => {
    const { cluster } = await serving();
    await expect(cluster.node({ host: "127.0.0.1", port: 0 })).rejects.toThrow(/already runs a node/);
  });

  it("stops listening when it is closed", async () => {
    const cluster = installCluster(makeCluster({ name: CLUSTER, self: SELF, cookie: COOKIE, creation: 7, announce: false }));
    const node = await startNode({ cluster, self: SELF, cookie: COOKIE, creation: 7, announce: false }, { host: "127.0.0.1", port: 0 });
    const port = node.port;
    await node.close();
    await expect(open(port, { host: "127.0.0.1", node: "probe", cookie: COOKIE, self: PEER, creation: 9 })).rejects.toThrow();
  });
  /** A term the served process answers, so a frame that came before it is known to have been read. */
  const beat = (peer: Channel<WireMessage>): Promise<void> =>
    peer.send({
      kind: "message",
      control: { kind: "regSend", from: PEER_PID, to: "answer" },
      payload: atom("still here"),
    });

  it("reports a watched process's end to the pid that asked, with the ref it minted", async () => {
    const { cluster, answerer, peer, frames } = await serving();
    const address = cluster.pidOf({ pname: answerer.pname, id: answerer.id });
    const ref = reference(PEER, 9);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: address, ref }, payload: null });
    // Frames on one connection are read in the order they arrive, so an answer proves the watch was recorded.
    await beat(peer);
    await until(() => frames.length === 1, "the watch to be read");
    await answerer.stop();
    await until(() => frames.length === 2, "the ending to be reported");

    expect(frames[1]?.kind === "message" && frames[1].control).toEqual({
      kind: "monitorExit",
      from: address,
      to: PEER_PID,
      ref,
      reason: atom("normal"),
    });
  });

  it("answers a watch set on a name with that name, not the pid it resolved to", async () => {
    const { answerer, peer, frames } = await serving();
    const ref = reference(PEER, 10);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: atom("answer"), ref }, payload: null });
    await beat(peer);
    await until(() => frames.length === 1, "the watch to be read");
    await answerer.stop();
    await until(() => frames.length === 2, "the ending to be reported");

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
    const { peer, frames } = await serving();
    const ref = reference(PEER, 11);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: atom("nobody"), ref }, payload: null });
    await until(() => frames.length === 1, "the answer to a watch on nobody");

    expect(frames[0]?.kind === "message" && frames[0].control).toEqual({
      kind: "monitorExit",
      from: atom("nobody"),
      to: PEER_PID,
      ref,
      reason: atom("noproc"),
    });

    // The connection is still the peer's: an address nobody answers says nothing about the wire.
    await beat(peer);
    await until(() => heard.length === 1, "the term that came after");
  });

  it("forgets a watch the peer cancelled: the process ends and nothing is said about it", async () => {
    const { cluster, answerer, peer, frames } = await serving();
    const address = cluster.pidOf({ pname: answerer.pname, id: answerer.id });
    const ref = reference(PEER, 12);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: address, ref }, payload: null });
    await beat(peer);
    await until(() => frames.length === 1, "the watch to be read");
    await peer.send({ kind: "message", control: { kind: "demonitor", from: PEER_PID, to: address, ref }, payload: null });
    await beat(peer);
    await until(() => frames.length === 2, "the cancel to be read");
    await answerer.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(frames).toHaveLength(2);
  });

  it("lets the ending it reported finish before the connection it goes over is let go", async () => {
    const { cluster, answerer, node, peer, frames } = await serving();
    const address = cluster.pidOf({ pname: answerer.pname, id: answerer.id });
    const ref = reference(PEER, 13);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: address, ref }, payload: null });
    await beat(peer);
    await until(() => frames.length === 1, "the watch to be read");
    // The end and the close happen in one turn: the peer that watched the process reads why it ended, and
    // `noconnection` would be a different fact.
    await answerer.stop();
    await node.close();
    expect(frames).toHaveLength(2);
  });

  it("answers a watch with the failure a process died of, not with normal", async () => {
    const { cluster, node, peer, frames } = await serving();
    const crasher = await Crasher.spawn(undefined);
    node.serve("crash", crasher);
    running.push(async () => crasher.stop());
    const address = cluster.pidOf({ pname: crasher.pname, id: crasher.id });
    const ref = reference(PEER, 14);
    await peer.send({ kind: "message", control: { kind: "monitor", from: PEER_PID, to: address, ref }, payload: null });
    await beat(peer);
    await until(() => frames.length === 1, "the watch to be read");

    // A send carries no sender, and that is all this needs: the term is what makes the handler throw.
    await peer.send({ kind: "message", control: { kind: "send", to: address }, payload: atom("boom") });
    await until(() => frames.length === 2, "the ending to be reported");

    expect(frames[1]?.kind === "message" && frames[1].control).toEqual({
      kind: "monitorExit",
      from: address,
      to: PEER_PID,
      ref,
      reason: tuple(atom("error"), binary(Buffer.from("the handler gave up", "utf8"))),
    });
  });

  it("ends a process here when the other end of a link says it ended", async () => {
    const { cluster, answerer, peer } = await serving();
    const address = cluster.pidOf({ pname: answerer.pname, id: answerer.id });
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
    const { cluster, answerer, peer, frames } = await serving();
    const address = cluster.pidOf({ pname: answerer.pname, id: answerer.id });
    await peer.send({ kind: "message", control: { kind: "link", from: PEER_PID, to: address }, payload: null });
    await peer.send({
      kind: "message",
      control: { kind: "exit", from: PEER_PID, to: address, reason: atom("normal") },
      payload: null,
    });

    // The process still answers, which is what a normal end at the other end of a link owes: nothing.
    await beat(peer);
    await until(() => frames.length === 1, "the answer that proves the process is up");
  });

  it("tells the other end of a link when a process here ends", async () => {
    const { cluster, node, answerer, frames } = await serving();
    const address = cluster.pidOf({ pname: answerer.pname, id: answerer.id });
    await node.link(address, PEER_PID);

    await answerer.stop();
    // The peer hears the link was made, and then that this end is over: a link ends both.
    await until(
      () => frames.some((said) => said.kind === "message" && said.control.kind === "exit"),
      "the exit to reach the peer",
    );

    const ended = frames.find((said) => said.kind === "message" && said.control.kind === "exit");
    expect(ended?.kind === "message" && ended.control).toEqual({
      kind: "exit",
      from: address,
      to: PEER_PID,
      reason: atom("normal"),
    });
  });
});
