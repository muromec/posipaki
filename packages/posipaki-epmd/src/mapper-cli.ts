#!/usr/bin/env node
// ── the mapper, as a program ────────────────────────────────────────────────
//
// The same `serveEpmd` a node starts when its policy says `"auto"`, with nothing around it. A host that runs several
// runtimes wants one mapper that outlives all of them — a node starting its own dies with it, and leaves the
// registrations of the others pointing at a process that is gone.
//
//   posipaki-epmd-mapper [--port 4369]
//
// A port already in use is another mapper answering there, and taking it over is not this program's to do.

import { serveEpmd } from "./epmd.js";

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
