#!/usr/bin/env bun
/**
 * Be watched by an Erlang process: run a node of this host, serve one process under a name, and ask the `watcher` on
 * the other node to watch it — by its pid, and by the name it is served under.
 *
 *   erlc robot.erl
 *   erl -name robot@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:start().'
 *
 *   bun demo/monitored.ts 192.168.88.20 pocookie --self posipaki@192.168.88.27 --to watcher
 *
 * The term carries this side's pid and the name it is served under. The other side watches both, says <<"exit">>, and
 * prints the two answers. This side prints what it heard and stops; its answers go out before the node closes, which is
 * why the other log says `normal` and not `noconnection`.
 */

import { randomBytes } from "node:crypto";

import { defineActor, defineMessages } from "posipaki";

import { makeCluster, nodeRef } from "../src/cluster.js";
import { startNode, type EtfAsked } from "../src/node.js";
import { proxyOf } from "../src/proxy.js";
import { processNamed, show, type VisibleTerm } from "../src/processes.js";
import { atom, binary, tuple } from "../src/terms.js";

/** How long the peer may take to answer before the connection gives up on it. */
const TIMEOUT_MS = 15_000;

function flag(argv: string[], name: string, fallback?: string): string {
  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is needed`);
  }
  return value;
}

/** The local part of a node name: the name a process of this node is served under. */
function localPart(name: string): string {
  const at = name.indexOf("@");
  if (at <= 0) throw new Error(`${name} is not a node name: it has no host`);
  return name.slice(0, at);
}

/** The word a term carries, when it carries one. */
function wordIn(body: VisibleTerm): string | null {
  return body.kind === "binary" ? body.bytes.toString("utf8") : null;
}

async function main(argv: string[]): Promise<void> {
  const host = argv[0];
  const cookie = argv[1];
  if (host === undefined || cookie === undefined) {
    throw new Error(
      "usage: bun demo/monitored.ts <host> <cookie> [--self posipaki@<host>] [--node robot] [--to watcher]",
    );
  }
  const nodeName = flag(argv, "node", "robot");
  const to = flag(argv, "to", "watcher");
  const self = flag(argv, "self", `posipaki@${host}`);
  const served = localPart(self);

  const cluster = makeCluster({
    // Nobody looks this node up: this side opens the connection, and the peer answers on that one rather than dialling.
    self,
    cookie,
    creation: randomBytes(4).readUInt32BE(0) || 1,
    timeoutMs: TIMEOUT_MS,
    announce: false,
  });
  const node = await startNode(cluster, { port: 0 });
  const watched = await Monitored.spawn(undefined);
  node.serve(served, watched);
  const pid = node.pidOf({ pname: watched.pname, id: watched.id });
  console.log(`${self} listening on ${node.port}, serving ${served}`);

  try {
    const proxy = await proxyOf(node, processNamed(nodeRef(nodeName, host), to, node)).spawn(undefined);
    await proxy.send({ type: "SEND", body: tuple(pid, atom(served), binary(Buffer.from("ping", "utf8"))) });
    console.log(`asked ${to} on ${nodeName}@${host} to watch ${show(pid)} and ${served}`);
    await watched.wait();
  } finally {
    // The answers a watch is owed go out before the connection they go over: what follows is the last word on it.
    await node.close();
    await node.close();
  }
}

/** Says what it heard, and stops when it is told to exit — which is what the watcher on the other side is watching. */
const Monitored = defineActor({
  name: "monitored",
  inMessages: defineMessages<EtfAsked>(),
  outMessages: defineMessages<never>(),
  handlers: {
    ETF_RAW(asked: EtfAsked) {
      console.log(`  heard ${show(asked.body)}`);
      if (wordIn(asked.body) !== "exit") return;
      console.log("exit requested");
      this.exit("exit requested");
    },
  },
});

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
