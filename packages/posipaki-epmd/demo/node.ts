#!/usr/bin/env bun
/**
 * A node of this host that answers: it starts a mapper when none answers, serves one process under its own name, and
 * prints every term that process is handed. The word in a term decides what it does: `hi` answers the process the term
 * names, `exit` ends the process, so a peer monitoring it reads a DOWN. An answer is a send of the actor's own: a served
 * process is never given a wire to write to.
 *
 * The words it answers are its own: `whois` says which pid this process answers at, so a peer can monitor it without
 * being told, and `exit` ends it. Nobody here asks a peer to watch this process: a monitor on the name arrives at this
 * node, which resolves it.
 *
 *   bun demo/node.ts                                            # posipaki@<this host>, cookie from ~/.erlang.cookie
 *   bun demo/node.ts --name probe@10.0.0.2 --cookie s3cret
 *   bun demo/node.ts --say relay --node robot@192.168.88.20     # and say hi to that name on that node
 *
 * It serves until stopped: ^C is how it ends.
 */

import { makeCluster, refFromName } from "../src/cluster.js";
import { startNode } from "../src/node.js";
import { binary, tuple } from "../src/terms.js";
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
  /** The node this run also says hi to, and the name there. */
  const net = flag(argv, "node");
  const say = flag(argv, "say");
  if (net === undefined && say !== undefined) throw new Error("--say needs --node <node@host>");

  // Nobody has to set a mapper up first: this node answers on its own host when none does.
  makeCluster({ epmd: { start: "auto" } });
  const node = await startNode({ self, cookie, host, port });
  // One process, served under this node's name and reachable by its pid: what a peer addresses arrives there.
  const answerer = await Answerer.spawn(undefined);
  node.registerProcess(served, answerer);
  console.log(`${self} listening on ${host}:${node.port}`);
  console.error(`${self} serves ${served} and stays up; ^C stops it`);

  // Asked to say hi: the term names the pid of this process, so the answer comes back to it.
  if (say !== undefined && net !== undefined) {
    await node.sendReg(say, refFromName(net), tuple(node.pidOf(answerer), binary(Buffer.from("hi", "utf8"))), answerer);
    console.log(`said hi to ${say} on ${net}`);
  }

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
