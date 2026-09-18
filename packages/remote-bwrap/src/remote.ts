// ── The way in ─────────────────────────────────────────────────────────────
//
// Everything below the entry is posipaki's: the payload and posipaki's gateway are staged
// through this same sandbox, the gateway makes its fifo inside it, and the client speaks
// the wire over the sandbox's own stdin/stdout.  All this package says is what a command
// looks like on the way in — and the sandbox lasts exactly as long as that command, which
// is why there is nothing to start, hold or clean up here.

import type { ClientSpawner } from "posipaki/remote";
import { gatewayClient } from "posipaki/remote/node";
import { bwrapEntry } from "./commands.js";
import type { BwrapRemoteSpec } from "./spec.js";

/**
 * Run a posipaki actor in a bubblewrap sandbox.
 *
 * Every spawn stages: the far side probes, so a kit that is already there — the same app
 * and the same build — is not written again, and a spawn of it costs one sandbox and no
 * copy.
 */
export function bwrapRemote<Args>(spec: BwrapRemoteSpec<Args>): ClientSpawner<Args> {
  const name = spec.name ?? "bwrap";
  return gatewayClient({
    ...spec,
    name,
    entry: (command) => bwrapEntry(spec.args, command),
  });
}
