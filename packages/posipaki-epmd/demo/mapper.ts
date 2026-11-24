#!/usr/bin/env bun
/**
 * The port mapper for this host: what a node asks when it wants to know where another node listens.
 *
 *   bun src/mapper.ts [--port 4369]
 *
 * Nodes register here as they start (see `node.ts`), and a node on another machine asks here before it connects.
 */

import { serveEpmd } from "../src/epmd.js";

function flag(argv: string[], name: string, fallback: string): string {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
}

async function main(): Promise<void> {
  const port = Number(flag(process.argv.slice(2), "port", "4369"));
  const mapper = await serveEpmd(port);
  console.log(`mapper on 0.0.0.0:${mapper.port}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void mapper.close().then(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
