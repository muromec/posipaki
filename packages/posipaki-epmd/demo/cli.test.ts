// ── the command line, as an actor ───────────────────────────────────────────
//
// The CLI over a real node: it forks the actor that stands for the name it was told, that child sends the term to it, and
// a term the CLI is given ends it with the text printed. The node is real and only `sendReg` is spied on, because what a
// case measures is that the term went out to the right name with the CLI's own pid inside it.

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeCluster, nodeRef, type NodeRef, type PidTerm } from "../src/cluster.js";
import { startNode, type EtfTerm, type ErlangNode } from "../src/node.js";
import { binary, tuple, type Term } from "../src/terms.js";
import { Cli } from "./cli.js";

const CLUSTER = "cli-test";
const REF = nodeRef("robot", "192.168.88.20", CLUSTER);

const opened: ErlangNode[] = [];
const spawned: Array<{ stop(): Promise<unknown> }> = [];

afterEach(async () => {
  // The spies stay in place until the actors have stopped: a restored verb is a real connection, and a closing actor
  // may ask for one.
  for (const proc of spawned.splice(0)) await proc.stop().catch(() => undefined);
  for (const erlang of opened.splice(0)) await erlang.close().catch(() => undefined);
  vi.restoreAllMocks();
});

/** A node of this side, with the one verb a case watches recorded — and a promise that settles when it is first called. */
async function serving(): Promise<{ erlang: ErlangNode; sent: Array<{ name: string; body: Term }>; arrived: Promise<void> }> {
  const sent: Array<{ name: string; body: Term }> = [];
  let seen: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const erlang = await startNode({
    clusterName: CLUSTER,
    self: "probe@192.168.88.27",
    cookie: "probe",
    register: false,
    host: "127.0.0.1",
    port: 0,
  });
  vi.spyOn(erlang, "sendReg").mockImplementation(async (name: string, _ref: NodeRef, body: Term) => {
    sent.push({ name, body });
    seen();
  });
  // The actor watches what it stands for; no peer answers here, so a watch that never settles is what the case needs.
  vi.spyOn(erlang, "watchName").mockImplementation(() => new Promise(() => undefined));
  opened.push(erlang);
  return { erlang, sent, arrived };
}

describe("Cli", () => {
  it("forks the actor, sends it the term, and ends with the answer printed", async () => {
    const { erlang, sent, arrived } = await serving();
    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const cli = await Cli.spawn({ node: REF, processName: "echo", message: "hi" });
    spawned.push(cli);

    await arrived;
    // The child sent what the CLI was told to say, to the name it was told to say it to — and the pid in the term is the
    // CLI's own, which is where the answer is expected.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("echo");
    const term = sent[0]?.body;
    expect(term?.kind).toBe("tuple");
    if (term?.kind !== "tuple") return;
    expect(term.items[0]).toEqual(erlang.pidOf(cli));

    // A term the node would deliver to the CLI is its in-message, and it ends the actor.
    const answered: EtfTerm = { type: "ETF_RAW", body: binary(Buffer.from("echo: hi", "utf8")) };
    await cli.send(answered);
    await cli.wait();

    expect(printed.mock.calls.map((call) => String(call[0]))).toContain("echo: hi");
  });
});
