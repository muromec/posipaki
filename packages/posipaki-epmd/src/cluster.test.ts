// ── a cluster: the nodes this runtime can reach ────────────────────────────
//
// Two of this side's halves over real sockets: the node that answers a pid is one `listen`, and the side that reaches
// it is a cluster. What the test measures is the rule — a reference names a node, and a node not yet reached is
// reached, once, and only if its incarnation agrees.

import { afterEach, describe, expect, it } from "vitest";
import { defineActor, defineMessages } from "posipaki";

import { createServer } from "node:net";

import { socketChannel } from "posipaki/port/node";

import { makeCluster, nodeName, nodeRef, refFromName, refOf, type Cluster } from "./cluster.js";
import { epmdPort, mapperAnswers, serveEpmd } from "./epmd.js";
import type { Peer } from "./handshake.js";
import { listen, type Listener } from "./listen.js";
import type { WireMessage } from "./messages.js";
import type { EtfAsked } from "./node.js";
import { atom } from "./terms.js";

const COOKIE = "pocookie";
const PEER = "peer@127.0.0.1";


const listeners: Listener[] = [];
const clusters: Cluster[] = [];

afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.close();
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

/** A cluster whose one node is the given port. */
function clusterAt(port: number): Cluster {
  const made = makeCluster({
    name: "test",
    self: "me@127.0.0.1",
    cookie: COOKIE,
    creation: 7,
    locate: async () => port,
    timeoutMs: 2_000,
  });
  clusters.push(made);
  return made;
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

describe("cluster", () => {
  it("reaches the node a pid names, and sends to it", async () => {
    const peer = await answer();
    const mine = clusterAt(peer.port);
    const said = peer.next();
    await mine.send(pidOf(PEER, 99), { kind: "binary", bytes: Buffer.from("hi", "utf8") });
    expect(await said).toBe("hi");
    expect(peer.peers).toMatchObject([{ name: "me@127.0.0.1" }]);
  });

  it("keeps one connection for one node", async () => {
    const peer = await answer();
    const mine = clusterAt(peer.port);
    const first = peer.next();
    await mine.send(pidOf(PEER, 99), { kind: "binary", bytes: Buffer.from("one", "utf8") });
    expect(await first).toBe("one");
    const second = peer.next();
    await mine.send(pidOf(PEER, 99), { kind: "binary", bytes: Buffer.from("two", "utf8") });
    expect(await second).toBe("two");
    expect(peer.peers).toHaveLength(1);
  });

  it("refuses a pid on this side's own name", async () => {
    const mine = clusterAt(1);
    await expect(mine.send(pidOf("me@127.0.0.1", 7), { kind: "binary", bytes: Buffer.alloc(0) })).rejects.toThrow(
      "me@127.0.0.1 is this side's own name",
    );
  });

  it("refuses a pid minted by another incarnation of the node it names", async () => {
    const peer = await answer();
    const mine = clusterAt(peer.port);
    // The node answers as incarnation 99; this pid was minted by 98, so there is nobody it can reach.
    await expect(mine.send(pidOf(PEER, 98), { kind: "binary", bytes: Buffer.from("hi", "utf8") })).rejects.toThrow(
      "answers as incarnation 99, and this pid was minted by 98",
    );
    expect(peer.said).toEqual([]);
  });
  it("gives each process its own pid, once, and knows it again from that pid", async () => {
    const mine = clusterAt(1);
    const first = { pname: "root:one", id: Symbol("one") };
    const second = { pname: "root:two", id: Symbol("two") };

    expect(mine.pidOf(first)).toEqual({ kind: "pid", node: "me@127.0.0.1", id: 1, serial: 0, creation: 7 });
    expect(mine.pidOf(first)).toBe(mine.pidOf(first));
    expect(mine.pidOf(second).id).toBe(2);

    expect(mine.processOf(mine.pidOf(first))).toBe(first);
    expect(mine.processOf(mine.pidOf(second))).toBe(second);
  });

  it("does not answer for a pid of another incarnation, or another node", () => {
    const mine = clusterAt(1);
    const one = { pname: "root:one", id: Symbol("one") };
    const pid = mine.pidOf(one);
    expect(mine.processOf({ ...pid, creation: 999 })).toBeNull();
    expect(mine.processOf({ ...pid, node: "somebody@127.0.0.1" })).toBeNull();
    expect(mine.processOf({ ...pid, id: 404 })).toBeNull();
  });
});

describe("a node's name", () => {
  it("is one atom on the wire, and three fields in a reference", () => {
    const ref = nodeRef("robot", "192.168.88.20", "test");
    expect(nodeName(ref)).toBe("robot@192.168.88.20");
    expect(refFromName("robot@192.168.88.20", "test")).toEqual(ref);
    expect(refOf({ kind: "pid", node: "robot@192.168.88.20", id: 1, serial: 0, creation: 7 }, "test")).toEqual(ref);
  });

  it("is refused when it names no host", () => {
    expect(() => refFromName("nobody", "test")).toThrow("nobody is not a node name: it has no host");
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

/** A cluster whose only way to announce itself is the policy: no `announce`, a mapper port the test names. */
function clusterWith(epmd: { port: number; start?: "auto" | "never" }): Cluster {
  const made = makeCluster({ name: "epmd", self: "me@127.0.0.1", cookie: COOKIE, creation: 7, epmd, timeoutMs: 2_000 });
  clusters.push(made);
  return made;
}

describe("the mapper a node joins", () => {
  it("serves one when the policy says auto and none answers, and closes it with the runtime", async () => {
    const mapperPort = await freePort();
    const mine = clusterWith({ port: mapperPort, start: "auto" });
    const node = await mine.node({ host: "127.0.0.1", port: 0 });

    const asked = await epmdPort(await socketChannel({ host: "127.0.0.1", port: mapperPort }), {
      host: "127.0.0.1",
      name: "me",
    });
    expect(asked).toBe(node.port);

    await node.close();
    await mine.close();
    // The mapper was this runtime's, and a registration is a connection to it: both end here.
    expect(await mapperAnswers("127.0.0.1", mapperPort)).toBe(false);
  });

  it("fails a node's start when none answers and the policy does not start one", async () => {
    const mapperPort = await freePort();
    const mine = clusterWith({ port: mapperPort });
    await expect(mine.node({ host: "127.0.0.1", port: 0 })).rejects.toThrow(
      `no mapper answered at 127.0.0.1:${mapperPort}`,
    );
  });

  it("joins a mapper that is already answering, and leaves it running", async () => {
    const mapperPort = await freePort();
    const mapper = await serveEpmd(mapperPort);
    try {
      const mine = clusterWith({ port: mapperPort, start: "auto" });
      const node = await mine.node({ host: "127.0.0.1", port: 0 });
      expect(mapper.find("me")).toBe(node.port);

      await node.close();
      await mine.close();
      // Not this runtime's to close: another process may have started it, and the nodes of that host share it.
      expect(await mapperAnswers("127.0.0.1", mapperPort)).toBe(true);
    } finally {
      await mapper.close();
    }
  });
});

describe("a watch this side sets", () => {
  /** A cluster with a node on a loopback port, serving one process under a name. */
  async function served(name: string) {
    const cluster = makeCluster({
      name: "serve",
      self: "probe@127.0.0.1",
      cookie: COOKIE,
      creation: 7,
      announce: false,
      timeoutMs: 2_000,
    });
    clusters.push(cluster);
    const node = await cluster.node({ host: "127.0.0.1", port: 0 });
    const proc = await Stand.spawn(undefined);
    node.serve(name, proc);
    return { node, proc, pid: cluster.pidOf({ pname: proc.pname, id: proc.id }) };
  }

  it("settles with normal when the process ends, watched by pid and by name", async () => {
    const { node, pid } = await served("answer");
    const mine = clusterAt(node.port);
    const byPid = mine.watch(pid);
    const byName = mine.watchName(nodeRef("answer", "127.0.0.1", "test"), "answer");

    // The watch and this send go over one connection, in that order: the node has read the monitors by the time the
    // process ends, so neither answer is a noproc.
    await mine.send(pid, atom("end"));

    expect(await byPid).toEqual(atom("normal"));
    expect(await byName).toEqual(atom("normal"));
  });

  it("settles as noconnection when the node it watched on goes", async () => {
    const { node, pid } = await served("answer");
    const mine = clusterAt(node.port);
    const ended = mine.watch(pid);
    await mine.send(pid, atom("still here"));

    await node.close();

    expect(await ended).toEqual(atom("noconnection"));
  });
});
