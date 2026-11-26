// ── a process on another node, as an actor here ─────────────────────────────
//
// The node is a double: it records what the proxy sends, gives it an address, and hands it what the far side answered.
// The proxy's own two facts are what the cases measure — a term goes to the address it was built with, and what the node
// delivers comes out with who asked.

import { afterEach, describe, expect, it } from "vitest";

import type { AnyProcess } from "posipaki";

import { nodeRef, type NodeRef, type PidTerm } from "./cluster.js";
import type { EtfAsked } from "./node.js";
import { processNamed, type ErlangProcess, type Reach } from "./processes.js";
import { proxyOf } from "./proxy.js";
import { atom, binary, type Term } from "./terms.js";

const PEER_PID: PidTerm = { kind: "pid", node: "robot@192.168.88.20", id: 91, serial: 0, creation: 5 };
const REF: NodeRef = nodeRef("robot", "192.168.88.20");

/** A node that records what was sent to a name, and the process it was told to hold. */
function fakeNode() {
  const sent: Array<{ name: string; body: Term }> = [];
  const held: AnyProcess[] = [];
  const node: Reach = {
    pidOf: (): PidTerm => PEER_PID,
    processOf: () => null,
    send: async () => undefined,
    sendReg: async (name: string, _ref: NodeRef, body: Term) => {
      sent.push({ name, body });
    },
    watch: () => new Promise(() => undefined),
    watchName: () => new Promise(() => undefined),
    kill: async () => undefined,
    link: async () => undefined,
    hold: (process: AnyProcess) => {
      held.push(process);
    },
  };
  return { node, sent, held };
}

/** The address a proxy is built with: a registered name, which is what a caller has before anything was said. */
const relay = (node: Reach, name = "relay"): ErlangProcess => processNamed(REF, name, node);

const opened: Array<{ stop(): Promise<unknown> }> = [];

afterEach(async () => {
  for (const proxy of opened.splice(0)) await proxy.stop().catch(() => undefined);
});

describe("proxyOf", () => {
  it("is held by the node, so what is sent to its address is handed to it", async () => {
    const { node, held } = fakeNode();
    const proxy = await proxyOf(node, relay(node)).spawn(undefined, {});
    opened.push(proxy);
    expect(held).toHaveLength(1);
    expect(held[0]?.pname).toBe(proxy.pname);
  });

  it("sends what arrives to the address it was built with, and says who sent it", async () => {
    const { node, sent } = fakeNode();
    const proxy = await proxyOf(node, relay(node)).spawn(undefined, {});
    opened.push(proxy);

    await proxy.send({ type: "SEND", body: atom("hi") });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("relay");
    expect(sent[0]?.body).toEqual(atom("hi"));
  });

  it("brings what the node delivered back out, with who asked", async () => {
    const { node } = fakeNode();
    const heard: EtfAsked[] = [];
    const proxy = await proxyOf(node, relay(node)).spawn(undefined, {
      toParent: (asked: EtfAsked) => heard.push(asked),
    });
    opened.push(proxy);

    const asked: EtfAsked = { type: "ETF_RAW", body: binary(Buffer.from("pong", "utf8")) };
    await proxy.send(asked);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard.map((one) => one.body)).toEqual([asked.body]);
  });

  it("ends when the process it stands for does", async () => {
    const { node } = fakeNode();
    const ended = processNamed(REF, "relay", { ...node, watchName: () => Promise.resolve(ENDED_AT_ONCE) });
    let over = false;
    const proxy = await proxyOf(node, ended).spawn(undefined, {});
    opened.push(proxy);
    void proxy.wait().then(() => {
      over = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(over).toBe(true);
  });
});

const ENDED_AT_ONCE = { ended: Promise.resolve(atom("normal")), cancel: () => undefined };
