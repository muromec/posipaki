#!/usr/bin/env bun
/**
 * A node of this host that answers: it starts a mapper when none answers, serves one process under its own name, prints
 * every term that process is handed, and answers the process the term names. The answer is a send of the actor's own —
 * a process this node holds is never given a wire to write to.
 *
 *   bun demo/node.ts                                   # posipaki@<this host>, cookie from ~/.erlang.cookie
 *   bun demo/node.ts --name probe@10.0.0.2 --cookie s3cret
 *
 * It serves until stopped: ^C is how it ends.
 */

import { randomBytes } from "node:crypto";

import { makeCluster } from "../src/cluster.js";
import { startNode } from "../src/node.js";
import { Answerer } from "./answerer.js";
import { cookieOf, nameOf } from "./settings.js";

/** A flag's value, or nothing when the run did not name it. */
function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined) throw new Error(`--${name} needs a value`);
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
  const self = nameOf(flag(argv, "name"));
  const cookie = cookieOf(flag(argv, "cookie"));
  const host = flag(argv, "host") ?? "0.0.0.0";
  const port = Number(flag(argv, "port") ?? "0");
  const served = localPart(self);

  const cluster = makeCluster({
    name: "demo",
    self,
    cookie,
    creation: randomBytes(4).readUInt32BE(0) || 1,
    // Nobody has to set a mapper up first: this node answers on its own host when none does.
    epmd: { start: "auto" },
  });
  const node = await startNode(cluster, { host, port });
  // One process, served under this node's name and reachable by its pid: what a peer addresses arrives there.
  const answerer = await Answerer.spawn(undefined);
  node.registerProcess(served, answerer);
  console.log(`${self} listening on ${host}:${node.port}`);
  console.error(`${self} serves ${served} and stays up; ^C stops it`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (async () => {
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
