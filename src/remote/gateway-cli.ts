// ── The gateway, as a program ──────────────────────────────────────────────
//
// A gateway is something a client runs: the first-stage command that makes a fifo
// inside a foreign environment and relays frames between its own stdin/stdout and
// the payload.  That is this file's whole job — it always serves, and it exits with
// the code the run ended in.
//
// Serving lives in ./gateway.js and starts nothing by itself.  A file cannot decide
// "am I the program?" from where it is: a consumer that bundles the node surface
// into its own program carries this code along, and there the bundle *is* the
// program — a payload would find a gateway booting on its wire.  So the decision is
// in the layout instead: importing a module never starts anything, and running this
// one always does.

import { GATEWAY_FAILED, runGateway } from "./gateway.js";

void (async () => {
  try {
    process.exitCode = await runGateway();
  } catch (err) {
    process.stderr.write(`gateway: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = GATEWAY_FAILED;
  }
})();
