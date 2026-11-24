#!/usr/bin/env bun
/**
 * Sends a term to a registered process on an Erlang node and prints the answer.
 *
 *   erlc robot.erl
 *   erl -name robot@192.168.88.20 -setcookie pocookie -noshell -eval 'robot:start().'
 *
 *   bun demo/client.ts 192.168.88.20 pocookie --to echo --message hi
 *
 * The cluster is the only thing this file sets up; everything after it is the `Cli` actor, which forks the proxy as
 * its child and ends when the answer arrives.
 */

import { randomBytes } from "node:crypto";

import { installCluster, makeCluster, nodeRef } from "../src/cluster.js";
import { withTimeout } from "../src/timeout.js";
import { parseArgs } from "./args.js";
import { Cli } from "./cli.js";

/** How long the answer may take before the client gives up on it. */
const TIMEOUT_MS = 10_000;

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const cluster = installCluster(
    makeCluster({
      // The incarnation this side claims: the pid the CLI puts in its message carries it, and the node's answer
      // comes back to the same one.
      self: options.self,
      cookie: options.cookie,
      creation: randomBytes(4).readUInt32BE(0) || 1,
      timeoutMs: TIMEOUT_MS,
    }),
  );

  const cli = await Cli.spawn({
    node: nodeRef(options.node, options.host),
    processName: options.to,
    message: options.message,
  });
  try {
    await withTimeout(cli.wait(), TIMEOUT_MS, "no answer from the node");
  } finally {
    // The connection the cluster holds is what keeps this process alive: closing it is the last thing main does.
    await cli.stop().catch(() => undefined);
    await cluster.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
