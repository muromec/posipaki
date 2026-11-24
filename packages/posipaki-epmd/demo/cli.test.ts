// ── the command line, as an actor ───────────────────────────────────────────
//
// The CLI over a cluster that is a memory pair: it forks the proxy as its child, that child writes to the far side,
// and an answer written back ends the CLI with the text printed.

import { afterEach, describe, expect, it, vi } from "vitest";

import { memoryChannelPair } from "posipaki/port";

import { forgetCluster, installCluster, nodeRef, type Cluster, type PidTerm } from "../src/cluster.js";
import type { WireMessage } from "../src/messages.js";
import { binary } from "../src/terms.js";
import { Cli } from "./cli.js";

const CLUSTER = "cli-test";
const REF = nodeRef("robot", "192.168.88.20", CLUSTER);
const OUR_PID: PidTerm = { kind: "pid", node: "probe@192.168.88.27", id: 1, serial: 0, creation: 7 };

const spawned: Array<{ stop(): Promise<unknown> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const proc of spawned.splice(0)) await proc.stop().catch(() => undefined);
  forgetCluster(CLUSTER);
});

/** A cluster whose one node is a memory pair. */
function fakeCluster() {
  const pair = memoryChannelPair<WireMessage>();
  const written: WireMessage[] = [];
  const cluster: Cluster = {
    name: CLUSTER,
    channel: async () => pair.near,
    address: () => OUR_PID,
    send: async () => undefined,
    adopt: () => undefined,
    close: async () => undefined,
  };
  pair.far.onFrame((said: WireMessage) => written.push(said));
  installCluster(cluster);
  return { written, far: pair.far };
}

describe("Cli", () => {
  it("forks the proxy, sends it the term, and ends with the answer printed", async () => {
    const { written, far } = fakeCluster();
    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const cli = await Cli.spawn({ node: REF, processName: "echo", message: "hi" });
    spawned.push(cli);
    let ended = false;
    void cli.wait().then(() => {
      ended = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The child wrote what the CLI was told to say, to the name it was told to say it to.
    const sent = written[0];
    expect(sent?.kind).toBe("message");
    if (sent?.kind !== "message") return;
    expect(sent.control).toEqual({ kind: "regSend", from: OUR_PID, to: "echo" });

    // An answer to that pid ends the CLI, and its text is what was printed.
    await far.send({
      kind: "message",
      control: { kind: "send", to: OUR_PID },
      payload: binary(Buffer.from("echo: hi", "utf8")),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ended).toBe(true);
    expect(printed.mock.calls.map((call) => String(call[0]))).toContain("echo: hi");
  });
});
