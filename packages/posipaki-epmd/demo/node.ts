#!/usr/bin/env bun
/**
 * One node of this host: it registers with the mapper, accepts connections, and can say something to a node that is
 * not us. Both roles of the protocol in one program.
 *
 *   bun demo/mapper.ts
 *   bun demo/node.ts --name probe@192.168.88.27 --cookie pocookie --say robot@192.168.88.20 --to relay
 *
 * `cluster.node` is the answering side — a listener, a registration, and the one process it serves — and the proxy is
 * the asking side. Both sides of the protocol, without a process standing between the frames and the tables.
 */

import { randomBytes } from "node:crypto";

import { makeCluster, refFromName } from "../src/cluster.js";
import { startNode, type EtfAsked } from "../src/node.js";
import { proxyOf } from "../src/proxy.js";
import { processNamed, show } from "../src/processes.js";
import { binary, tuple } from "../src/terms.js";
import { Answerer } from "./answerer.js";

function flag(argv: string[], name: string, fallback?: string): string {
  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is needed`);
  }
  return value;
}

/** The local part of a node name: what the mapper registers, and what a peer addresses. */
function localPart(name: string): string {
  const at = name.indexOf("@");
  if (at <= 0) throw new Error(`${name} is not a node name: it has no host`);
  return name.slice(0, at);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const self = flag(argv, "name");
  const cookie = flag(argv, "cookie");
  const host = flag(argv, "host", "0.0.0.0");
  const port = Number(flag(argv, "port", "0"));
  const say = argv.includes("--say") ? flag(argv, "say") : null;
  const to = flag(argv, "to", "relay");
  const message = flag(argv, "message", "hi");
  const creation = randomBytes(4).readUInt32BE(0) || 1;

  const cluster = makeCluster({ name: "demo", self, cookie, creation });
  const node = await startNode(cluster, { host, port });
  // One process, served under this node's name and reachable by its pid: what a peer addresses arrives there.
  const answerer = await Answerer.spawn(undefined);
  node.registerProcess(localPart(self), answerer);
  console.log(`${self} listening on ${host}:${node.port}`);

  if (say !== null) {
    const where = refFromName(say, cluster.name);
    // The asking side: a proxy speaks for one name on that node, and what comes back is its out-message.
    const proxy = await proxyOf(node, processNamed(where, to, node)).spawn(undefined, {
      toParent: (heard: EtfAsked) => console.log(`  ${to} answered: ${show(heard.body)}`),
    });
    console.log(`saying ${JSON.stringify(message)} to ${to} on ${say}`);
    // The term carries a pid of this node, so whoever it reaches has somewhere to answer — and this node routes it back.
    proxy.send({ type: "SEND", body: tuple(node.pidOf(answerer), binary(Buffer.from(message, "utf8"))) });
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (async () => {
        await node.close();
        await node.close();
        process.exit(0);
      })();
    });
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
