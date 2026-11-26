// ── the command line, as an actor ───────────────────────────────────────────
//
// The CLI over a node that is a double: it forks the proxy as its child, that child sends the term to the name it was
// told, and a term the node delivers to the CLI ends it with the text printed.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnyProcess } from "posipaki";

import { nodeRef, type NodeRef, type PidTerm, type ProcessHandle } from "../src/cluster.js";
import { forgetNode, installNode, type EtfAsked, type Reach } from "../src/node.js";
import { binary, tuple, type Term } from "../src/terms.js";
import { Cli } from "./cli.js";

const CLUSTER = "cli-test";
const REF = nodeRef("robot", "192.168.88.20", CLUSTER);
const OUR_PID: PidTerm = { kind: "pid", node: "probe@192.168.88.27", id: 1, serial: 0, creation: 7 };

const spawned: Array<{ stop(): Promise<unknown> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const proc of spawned.splice(0)) await proc.stop().catch(() => undefined);
  forgetNode(CLUSTER);
});

/** A node that mints one pid per process, records what was sent to a name, and remembers what it serves. */
function fakeNode() {
  const pids = new Map<symbol, PidTerm>();
  const sent: Array<{ name: string; body: Term }> = [];
  /** Every process the node was asked for an address for: asking is what serves it. */
  const held: AnyProcess[] = [];
  const node: Reach = {
    pidOf: (process: AnyProcess): PidTerm => {
      held.push(process);
      const known = pids.get(process.id);
      if (known !== undefined) return known;
      const minted: PidTerm = { ...OUR_PID, id: pids.size + 1 };
      pids.set(process.id, minted);
      return minted;
    },
    processOf: () => null,
    send: async () => undefined,
    sendReg: async (name: string, _ref: NodeRef, body: Term) => {
      sent.push({ name, body });
    },
    // The double answers no watches: a promise that never settles is a peer that never ends anything.
    watch: () => new Promise(() => undefined),
    watchName: () => new Promise(() => undefined),
    kill: async () => undefined,
    link: async () => undefined,
      spawn: async () => {
        throw new Error("this double starts nothing");
      },
  };
  installNode(node, CLUSTER);
  return { sent, held, pids };
}

describe("Cli", () => {
  it("forks the proxy, sends it the term, and ends with the answer printed", async () => {
    const { sent, held, pids } = fakeNode();
    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const cli = await Cli.spawn({ node: REF, processName: "echo", message: "hi" });
    spawned.push(cli);
    let ended = false;
    void cli.wait().then(() => {
      ended = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The child sent what the CLI was told to say, to the name it was told to say it to — and the pid in the term is
    // the CLI's own, which is where the answer is expected.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("echo");
    const term = sent[0]?.body;
    expect(term?.kind).toBe("tuple");
    if (term?.kind !== "tuple") return;
    expect(term.items[0]).toEqual(pids.get(cli.id));

    // The CLI is the process the node serves at that address, so a term the node delivers is its in-message.
    const mine = held.find((process) => process.id === cli.id);
    expect(mine).toBeDefined();
    const answered: EtfAsked = { type: "ETF_RAW", body: binary(Buffer.from("echo: hi", "utf8")) };
    await mine?.send(answered);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ended).toBe(true);
    expect(printed.mock.calls.map((call) => String(call[0]))).toContain("echo: hi");
  });
});
