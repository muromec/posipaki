// ── a cluster: the nodes this runtime can reach ────────────────────────────
//
// Two of this side's halves over real sockets: the node that answers a pid is one `listen`, and the side that reaches
// it is a cluster. What the test measures is the rule — a reference names a node, and a node not yet reached is
// reached, once, and only if its incarnation agrees.

import { afterEach, describe, expect, it } from "vitest";

import { makeCluster, nodeName, nodeRef, refFromName, refOf, type Cluster } from "./cluster.js";
import type { Peer } from "./handshake.js";
import { listen, type Listener } from "./listen.js";
import type { WireMessage } from "./messages.js";

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
  it("gives each reference its own pid, and the same one every time", async () => {
    const mine = clusterAt(1);
    const one = nodeRef("peer", "127.0.0.1", "test");
    const two = nodeRef("peer", "127.0.0.1", "test");
    expect(mine.address(one)).toEqual({ kind: "pid", node: "me@127.0.0.1", id: 1, serial: 0, creation: 7 });
    expect(mine.address(one)).toBe(mine.address(one));
    expect(mine.address(two).id).toBe(2);
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
