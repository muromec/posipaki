#!/usr/bin/env bun
/**
 * Sends a term to a registered process on an Erlang node, as one message of a proxy actor, and prints what comes back.
 *
 *   erlc robot.erl
 *   erl -name robot@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:start().'
 *
 *   bun demo/client.ts 192.168.88.20 pocookie --to echo --message hi
 *
 * The proxy is `ErlangProxy`: this file builds the cluster it is forked into, the reference it names the node with,
 * and the term it carries.
 */

import { randomBytes } from "node:crypto";

import { installCluster, makeCluster, nodeRef } from "../src/cluster.js";
import { ErlangProxy, type EtfRaw } from "../src/proxy.js";
import { render, type Term } from "../src/terms.js";
import { withTimeout } from "../src/timeout.js";
import { parseArgs } from "./args.js";

/** How long the answer may take before the client gives up on it. */
const TIMEOUT_MS = 10_000;

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const creation = randomBytes(4).readUInt32BE(0) || 1;
  const cluster = installCluster(
    makeCluster({
      name: "demo",
      self: options.self,
      cookie: options.cookie,
      creation,
      timeoutMs: TIMEOUT_MS,
    }),
  );

  // The reference is the proxy's identity, so the pid minted from it here is the one the actor will send from: a
  // process on the node answers that pid, and only a message that carried it can be answered at all.
  const ref = nodeRef(options.node, options.host, cluster.name);
  const ourPid = cluster.address(ref);
  const body: Term = {
    kind: "tuple",
    items: [ourPid, { kind: "binary", bytes: Buffer.from(options.message, "utf8") }],
  };

  const said = new Promise<EtfRaw>((resolve) => {
    void ErlangProxy.spawn({ node: ref, processName: options.to }, { toParent: (message: EtfRaw) => resolve(message) })
      .then((proxy) => {
        console.log(`${options.node}@${options.host} as ${options.to}, our pid ${ourPid.id}`);
        void proxy.send({ type: "ETF_RAW", body });
      });
  });

  const answer = await withTimeout(said, TIMEOUT_MS, "no answer from the node");
  console.log(render(answer.body));
  await cluster.close();
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
