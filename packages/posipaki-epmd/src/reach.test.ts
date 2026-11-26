// ── reaching another node: connections, pids, watches and starts ─────────────
//
// One side is a real node that nobody can look up (`announce: false`); the other is a socket that answers by hand. What
// the test measures is the rule: a reference names a node, a node not yet reached is reached once, and only if its
// incarnation agrees.

import { afterEach, describe, expect, it } from "vitest";
import { defineActor, defineMessages } from "posipaki";

import { createServer } from "node:net";

import type { Channel } from "posipaki/port";
import { socketChannel } from "posipaki/port/node";

import { makeCluster, nodeRef, refOf, type Cluster } from "./cluster.js";
import { epmdPort, mapperAnswers, serveEpmd } from "./epmd.js";
import type { Peer } from "./handshake.js";
import { listen, type Listener } from "./listen.js";
import type { WireMessage } from "./messages.js";
import { startNode, type ErlangNode, type EtfAsked } from "./node.js";
import { atom, integer, list, pid as pidTerm, tuple, type Term } from "./terms.js";

const COOKIE = "pocookie";
const PEER = "peer@127.0.0.1";


const listeners: Listener[] = [];
const nodes: ErlangNode[] = [];

afterEach(async () => {
  for (const node of nodes.splice(0)) await node.close();
  for (const listener of listeners.splice(0)) await listener.close();
});


/** A node that records who connected and what it was sent. */
async function answer(): Promise<{ port: number; peers: Peer[]; said: string[]; next: () => Promise<string> }> {
  const peers: Peer[] = [];
  const said: string[] = [];
  const waiting: Array<(text: string) => void> = [];
  const listener = await listen(
    { self: PEER, cookie: COOKIE, creation: 99, timeoutMs: 2_000 },
    {
      onConnection(peer: Peer, messages) {
        peers.push(peer);
        messages.onFrame((message: WireMessage) => {
          if (message.kind !== "message" || message.payload?.kind !== "binary") return;
          const text = Buffer.from(message.payload.bytes).toString("utf8");
          said.push(text);
          waiting.shift()?.(text);
        });
      },
    },
  );
  listeners.push(listener);
  return {
    port: listener.port,
    peers,
    said,
    next: () => new Promise<string>((resolve) => waiting.push(resolve)),
  };
}

/** A node of this side whose only node it reaches is the given port. */
async function reachAt(port: number): Promise<ErlangNode> {
  const node = await startNode(
    makeCluster({
      name: "test",
      self: "me@127.0.0.1",
      cookie: COOKIE,
      creation: 7,
      locate: async () => port,
      announce: false,
      timeoutMs: 2_000,
    }),
    { host: "127.0.0.1", port: 0 },
  );
  nodes.push(node);
  return node;
}

const pidOf = (node: string, creation: number) => ({ kind: "pid" as const, node, id: 1, serial: 0, creation });

/** Ends when it is told to, so a watch has an end to be answered for and other terms prove the order. */
const Stand = defineActor({
  name: "stand",
  inMessages: defineMessages<EtfAsked>(),
  outMessages: defineMessages<never>(),
  handlers: {
    ETF_RAW(asked: EtfAsked) {
      if (asked.body.kind === "atom" && asked.body.name === "end") this.exit("done");
    },
  },
});

/** A node serving one process under a name: what a pid is minted for, and what a watch has to end. */
async function served(name: string) {
  const node = await startNode(
    makeCluster({ name: "serve", self: "probe@127.0.0.1", cookie: COOKIE, creation: 7, announce: false, timeoutMs: 2_000 }),
    { host: "127.0.0.1", port: 0 },
  );
  nodes.push(node);
  const proc = await Stand.spawn(undefined);
  node.registerProcess(name, proc);
  return { node, proc, pid: node.pidOf(proc) };
}

describe("reaching a node", () => {
  it("reaches the node a pid names, and sends to it", async () => {
    const peer = await answer();
    const mine = await reachAt(peer.port);
    const said = peer.next();
    await mine.send(pidOf(PEER, 99), { kind: "binary", bytes: Buffer.from("hi", "utf8") });
    expect(await said).toBe("hi");
    expect(peer.peers).toMatchObject([{ name: "me@127.0.0.1" }]);
  });

  it("keeps one connection for one node", async () => {
    const peer = await answer();
    const mine = await reachAt(peer.port);
    const first = peer.next();
    await mine.send(pidOf(PEER, 99), { kind: "binary", bytes: Buffer.from("one", "utf8") });
    expect(await first).toBe("one");
    const second = peer.next();
    await mine.send(pidOf(PEER, 99), { kind: "binary", bytes: Buffer.from("two", "utf8") });
    expect(await second).toBe("two");
    expect(peer.peers).toHaveLength(1);
  });

  it("refuses a pid on this side's own name", async () => {
    const mine = await reachAt(1);
    await expect(mine.send(pidOf("me@127.0.0.1", 7), { kind: "binary", bytes: Buffer.alloc(0) })).rejects.toThrow(
      "me@127.0.0.1 is this side's own name",
    );
  });

  it("refuses a pid minted by another incarnation of the node it names", async () => {
    const peer = await answer();
    const mine = await reachAt(peer.port);
    // The node answers as incarnation 99; this pid was minted by 98, so there is nobody it can reach.
    await expect(mine.send(pidOf(PEER, 98), { kind: "binary", bytes: Buffer.from("hi", "utf8") })).rejects.toThrow(
      "answers as incarnation 99, and this pid was minted by 98",
    );
    expect(peer.said).toEqual([]);
  });
  it("gives a process one pid, minted once, and answers its process by that pid", async () => {
    const { node, proc, pid } = await served("answer");
    expect(pid).toEqual({ kind: "pid", node: "probe@127.0.0.1", id: 1, serial: 0, creation: 7 });
    expect(node.pidOf(proc)).toBe(pid);

    expect(node.processOf(pid)).toBe(proc);
    const other = await Stand.spawn(undefined);
    expect(node.pidOf(other).id).not.toBe(pid.id);
    await other.stop();
  });

  it("answers nobody for a pid of another incarnation, another node, or a process it does not serve", async () => {
    const { node, pid } = await served("answer");
    expect(node.processOf({ ...pid, creation: 999 })).toBeNull();
    expect(node.processOf({ ...pid, node: "somebody@127.0.0.1" })).toBeNull();
    expect(node.processOf({ ...pid, id: 404 })).toBeNull();
  });
});


/** A port on this host that nothing holds: bound once to learn it, and let go. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      resolve(address === null || typeof address === "string" ? 0 : address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The configuration of a node whose only way to announce itself is the policy: no `announce`, a mapper port named. */
function configuredWith(epmd: { port: number; start?: "auto" | "never" }): Cluster {
  return makeCluster({ name: "epmd", self: "me@127.0.0.1", cookie: COOKIE, creation: 7, epmd, timeoutMs: 2_000 });
}

describe("the mapper a node joins", () => {
  it("serves one when the policy says auto and none answers, and closes it with the node", async () => {
    const mapperPort = await freePort();
    const node = await startNode(configuredWith({ port: mapperPort, start: "auto" }), { host: "127.0.0.1", port: 0 });

    const asked = await epmdPort(await socketChannel({ host: "127.0.0.1", port: mapperPort }), {
      host: "127.0.0.1",
      name: "me",
    });
    expect(asked).toBe(node.port);

    // The mapper was this runtime's, and a registration is a connection to it: both end here, and the node closes both.
    await node.close();
    expect(await mapperAnswers("127.0.0.1", mapperPort)).toBe(false);
  });

  it("fails a node's start when none answers and the policy does not start one", async () => {
    const mapperPort = await freePort();
    await expect(
      startNode(configuredWith({ port: mapperPort }), { host: "127.0.0.1", port: 0 }),
    ).rejects.toThrow(`no mapper answered at 127.0.0.1:${mapperPort}`);
  });

  it("joins a mapper that is already answering, and leaves it running", async () => {
    const mapperPort = await freePort();
    const mapper = await serveEpmd(mapperPort);
    try {
      const node = await startNode(configuredWith({ port: mapperPort, start: "auto" }), {
        host: "127.0.0.1",
        port: 0,
      });
      expect(mapper.find("me")).toBe(node.port);

      await node.close();
      // Not this runtime's to close: another process may have started it, and the nodes of that host share it.
      expect(await mapperAnswers("127.0.0.1", mapperPort)).toBe(true);
    } finally {
      await mapper.close();
    }
  });
});

describe("a watch this side sets", () => {
  it("settles with normal when the process ends, watched by pid and by name", async () => {
    const { node, pid } = await served("answer");
    const mine = await reachAt(node.port);
    const byPid = (await mine.watch(pid)).ended;
    const byName = (await mine.watchName(nodeRef("answer", "127.0.0.1", "test"), "answer")).ended;

    // The watch and this send go over one connection, in that order: the node has read the monitors by the time the
    // process ends, so neither answer is a noproc.
    await mine.send(pid, atom("end"));

    expect(await byPid).toEqual(atom("normal"));
    expect(await byName).toEqual(atom("normal"));
  });

  it("settles as noconnection when the node it watched on goes", async () => {
    const { node, pid } = await served("answer");
    const mine = await reachAt(node.port);
    const ended = (await mine.watch(pid)).ended;
    await mine.send(pid, atom("still here"));

    await node.close();

    expect(await ended).toEqual(atom("noconnection"));
  });

  it("stops waiting when the watch is cancelled, and the process may end after that", async () => {
    const { node, pid } = await served("answer");
    const mine = await reachAt(node.port);
    const watch = await mine.watch(pid);
    let settled = false;
    void watch.ended.then(() => {
      settled = true;
    });

    watch.cancel();
    await mine.send(pid, atom("end"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settled).toBe(false);
  });
});

describe("a start this side asks for", () => {
  /** A node that answers a start with the pid of a process it pretends to have made. */
  async function starter(answer: Term): Promise<{ port: number; call: Term[]; args: Term[] }> {
    const call: Term[] = [];
    const args: Term[] = [];
    const listener = await listen(
      { self: PEER, cookie: COOKIE, creation: 99, timeoutMs: 2_000 },
      {
        onConnection(_peer: Peer, messages: Channel<WireMessage>) {
          messages.onFrame((said: WireMessage) => {
            if (said.kind !== "message" || said.control.kind !== "spawn") return;
            call.push(said.control.call);
            args.push(said.payload ?? atom("nothing"));
            void messages.send({
              kind: "message",
              control: { kind: "spawnReply", ref: said.control.ref, to: said.control.from, flags: integer(0), answer },
              payload: null,
            });
          });
        },
      },
    );
    listeners.push(listener);
    return { port: listener.port, call, args };
  }

  it("answers a handle to the process the node started", async () => {
    const started = pidTerm(PEER, 77, 0, 99);
    const { port, call, args } = await starter(started);
    const mine = await reachAt(port);

    const process = await mine.spawn(nodeRef("robot", "127.0.0.1", "test"), {
      module: "timer",
      function: "sleep",
      args: [integer(200)],
    });

    expect(process.address).toEqual({ kind: "pid", pid: started });
    // The control names the function and its arity; the arguments ride the message after it.
    expect(call).toEqual([tuple(atom("timer"), atom("sleep"), integer(1))]);
    expect(args).toEqual([list(integer(200))]);
  });

  it("refuses in a sentence when the node says no", async () => {
    const { port } = await starter(atom("noproc"));
    const mine = await reachAt(port);

    await expect(
      mine.spawn(nodeRef("robot", "127.0.0.1", "test"), { module: "timer", function: "sleep", args: [] }),
    ).rejects.toThrow("refused to start a process: noproc");
  });
});
