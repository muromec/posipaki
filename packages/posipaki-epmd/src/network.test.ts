// ── reaching a pid ────────────────────────────────────────────────────────
//
// Two of this side's halves over real sockets: the node that answers a pid is one `listen`, and the side that reaches
// it is a `network`. What the test measures is the rule — a pid names a node, and a node not yet reached is reached.

import { afterEach, describe, expect, it } from "vitest";

import { listen, type Listener } from "./listen.js";
import { open } from "./connection.js";
import { network, type Network, type PidTerm } from "./network.js";
import type { Peer } from "./handshake.js";
import type { WireMessage } from "./messages.js";

const COOKIE = "pocookie";
const PEER = "peer@127.0.0.1";

const listeners: Listener[] = [];
const networks: Network[] = [];

afterEach(async () => {
  for (const made of networks.splice(0)) await made.close();
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

function pidOf(node: string, creation: number): PidTerm {
  return { kind: "pid", node, id: 1, serial: 0, creation };
}

describe("network", () => {
  it("reaches the node a pid names, and sends to it", async () => {
    const peer = await answer();
    const mine = network({ self: "me@127.0.0.1", cookie: COOKIE, creation: 7, locate: async () => peer.port, timeoutMs: 2_000 });
    networks.push(mine);
    const said = peer.next();
    await mine.send(pidOf(PEER, 99), { kind: "binary", bytes: Buffer.from("hi", "utf8") });
    expect(await said).toBe("hi");
    expect(peer.peers).toMatchObject([{ name: "me@127.0.0.1" }]);
  });

  it("keeps one connection for one node", async () => {
    const peer = await answer();
    const mine = network({ self: "me@127.0.0.1", cookie: COOKIE, creation: 7, locate: async () => peer.port, timeoutMs: 2_000 });
    networks.push(mine);
    const first = peer.next();
    await mine.send(pidOf(PEER, 99), { kind: "binary", bytes: Buffer.from("one", "utf8") });
    expect(await first).toBe("one");
    const second = peer.next();
    await mine.send(pidOf(PEER, 99), { kind: "binary", bytes: Buffer.from("two", "utf8") });
    expect(await second).toBe("two");
    expect(peer.peers).toHaveLength(1);
  });

  it("refuses a pid on this side's own name", async () => {
    const mine = network({ self: "me@127.0.0.1", cookie: COOKIE, creation: 7, locate: async () => 1 });
    networks.push(mine);
    await expect(mine.send(pidOf("me@127.0.0.1", 7), { kind: "binary", bytes: Buffer.alloc(0) })).rejects.toThrow(
      "me@127.0.0.1 is this side's own name",
    );
  });
});

describe("incarnations", () => {
  it("refuses a pid minted by another incarnation of the node it names", async () => {
    const peer = await answer();
    const mine = network({ self: "me@127.0.0.1", cookie: COOKIE, creation: 7, locate: async () => peer.port, timeoutMs: 2_000 });
    networks.push(mine);
    // The node answers as incarnation 99; this pid was minted by 98, so there is nobody it can reach.
    await expect(
      mine.send(pidOf(PEER, 98), { kind: "binary", bytes: Buffer.from("hi", "utf8") }),
    ).rejects.toThrow("answers as incarnation 99, and this pid was minted by 98");
    expect(peer.said).toEqual([]);
  });

  it("uses a connection that arrived rather than dialling the node again", async () => {
    let dials = 0;
    const mine = network({
      self: "me@127.0.0.1",
      cookie: COOKIE,
      creation: 7,
      timeoutMs: 2_000,
      locate: async () => {
        dials += 1;
        return 1;
      },
    });
    networks.push(mine);
    let adopted: () => void = () => undefined;
    const adoption = new Promise<void>((resolve) => {
      adopted = resolve;
    });
    const ours = await listen(
      { self: "me@127.0.0.1", cookie: COOKIE, creation: 7, timeoutMs: 2_000 },
      {
        onConnection(connected, messages) {
          mine.adopt(connected, messages);
          adopted();
        },
      },
    );
    listeners.push(ours);

    // The peer opens the connection, and what it says comes back over that same one: no second dial.
    const client = await open(ours.port, {
      host: "127.0.0.1",
      node: "me",
      cookie: COOKIE,
      self: PEER,
      creation: 99,
      timeoutMs: 2_000,
    });
    await adoption;
    const said = new Promise<string>((resolve) => {
      client.messages.onFrame((message: WireMessage) => {
        if (message.kind === "message" && message.payload?.kind === "binary") {
          resolve(Buffer.from(message.payload.bytes).toString("utf8"));
        }
      });
    });
    await mine.send(pidOf(PEER, 99), { kind: "binary", bytes: Buffer.from("over it", "utf8") });
    expect(await said).toBe("over it");
    expect(dials).toBe(0);
    await client.messages.close("done");
  });
});

describe("ref", () => {
  it("gives each proxy its own pid, and never a second one for the same proxy", async () => {
    const mine = network({ self: "me@127.0.0.1", cookie: COOKIE, creation: 7, locate: async () => 1 });
    networks.push(mine);
    const one = mine.ref(PEER);
    const two = mine.ref(PEER);
    expect(one.address()).toEqual({ kind: "pid", node: "me@127.0.0.1", id: 1, serial: 0, creation: 7 });
    expect(one.address()).toBe(one.address());
    expect(two.address().id).toBe(2);
  });
});
