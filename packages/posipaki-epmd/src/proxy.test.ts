// ── a registered process on a node, as an actor here ────────────────────────
//
// The node is a memory pair: what the proxy writes is what the far side reads, and what the far side writes is what
// the proxy is handed. One connection, several pids — which is what the routing case is for.

import { afterEach, describe, expect, it, vi } from "vitest";

import { memoryChannelPair } from "posipaki/port";

import type { WireMessage } from "./messages.js";
import { ErlangProxy, type EtfRaw, type NodeRef } from "./proxy.js";
import type { PidTerm } from "./network.js";
import type { Term } from "./terms.js";

const PID: PidTerm = { kind: "pid", node: "probe@192.168.88.27", id: 1, serial: 0, creation: 7 };
const OTHER: PidTerm = { ...PID, id: 2 };

/** A node on the other side of a memory pair, with one address per proxy. */
function nodeRef(name = "robot@192.168.88.20") {
  const pair = memoryChannelPair<WireMessage>();
  const written: WireMessage[] = [];
  const closed: string[] = [];
  let next = 1;
  const ref: NodeRef = {
    name,
    channel: async () => pair.near,
    address: (): PidTerm => ({ ...PID, id: next++ }),
  };
  pair.far.onFrame((said: WireMessage) => written.push(said));
  pair.far.onClose((reason: string) => closed.push(reason));
  return { ref, written, closed, far: pair.far };
}

const atomOf = (name: string): Term => ({ kind: "atom", name });
const say = (body: Term): EtfRaw => ({ type: "ETF_RAW", body });

/** A proxy and everything it emitted. */
async function proxyOf(ref: NodeRef, processName = "relay") {
  const out: EtfRaw[] = [];
  const proxy = await ErlangProxy.spawn(
    { node: ref, processName },
    { toParent: (message: EtfRaw) => out.push(message) },
  );
  return { proxy, out };
}

/** A moment for the frames to cross. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

const opened: Array<{ stop(): Promise<unknown> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const proxy of opened.splice(0)) await proxy.stop().catch(() => undefined);
});

describe("ErlangProxy", () => {
  it("carries a term to the name it was forked with", async () => {
    const { ref, written } = nodeRef();
    const { proxy } = await proxyOf(ref);
    opened.push(proxy);
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
    const { ref, far } = nodeRef();
    const { proxy, out } = await proxyOf(ref);
    opened.push(proxy);
    await far.send({ kind: "message", control: { kind: "send", to: PID }, payload: atomOf("pong") });
    await settle();
    expect(out).toEqual([{ type: "ETF_RAW", body: atomOf("pong") }]);
  });

  it("says nothing about a message for another pid on the same connection", async () => {
    const { ref, far } = nodeRef();
    const { proxy, out } = await proxyOf(ref);
    opened.push(proxy);
    await far.send({ kind: "message", control: { kind: "send", to: OTHER }, payload: atomOf("not mine") });
    await settle();
    expect(out).toEqual([]);
  });

  it("ends when the connection does", async () => {
    const { ref, far } = nodeRef();
    const { proxy } = await proxyOf(ref);
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

  it("complains about a term it cannot write, and carries on", async () => {
    const { ref, written } = nodeRef();
    const { proxy } = await proxyOf(ref);
    opened.push(proxy);
    const complained = vi.spyOn(console, "error").mockImplementation(() => undefined);
    proxy.send(say({ kind: "ref", node: "robot@192.168.88.20" }));
    await settle();
    expect(complained).toHaveBeenCalled();
    expect(String(complained.mock.calls[0]?.[0])).toContain("reference");
    expect(written).toEqual([]);
    // Still able to carry what it can.
    proxy.send(say(atomOf("still here")));
    await settle();
    expect(written).toHaveLength(1);
  });
});
