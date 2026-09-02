// ── remote module: node/bun surface ─────────────────────────────────────────────
//
// The node/bun-only pieces of the remote seam: the FIFO transport, its two
// spawners, and the subprocess glue.  Importing this from a browser is a
// mistake — it pulls in node:fs / node:child_process / node:readline.  The
// portable seam lives in ./index.js.

export { FifoUtf8NlineTransport } from "./transports/fifo.js";
export { commandSpawner } from "./spawners/fifo-command.js";
export { fifoArgvSpawner } from "./spawners/fifo-argv.js";
export { defineSubprocessActor } from "./define-subprocess.js";
export type { SubprocessActorOptions, SubprocessActorBundle } from "./define-subprocess.js";
