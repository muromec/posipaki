// ── The way in ─────────────────────────────────────────────────────────────
//
// Everything below the entry is posipaki's: the payload and posipaki's gateway are staged
// onto this host, the gateway makes its fifo there, and the client speaks the wire over the
// ssh process's own stdin/stdout.  All this package says is what a command looks like on
// the way out.

import type { ClientSpawner } from "posipaki/remote";
import { gatewayClient } from "posipaki/remote/node";
import { sshEntry } from "./commands.js";
import type { SshRemoteSpec } from "./spec.js";

/**
 * Run a posipaki actor on an ssh host.
 *
 * Every spawn stages: the far side probes, so a kit that is already there — the same app
 * and the same build — is not written again, and a spawn of it costs one `ssh` and no
 * copy.  The host is asked for, never derived: two consumers naming the same box is their
 * business, and this package has nothing to keep straight about it.
 */
export function sshRemote<Args>(spec: SshRemoteSpec<Args>): ClientSpawner<Args> {
  return gatewayClient({
    ...spec,
    name: spec.name ?? spec.host,
    entry: (command) => sshEntry(spec.host, command),
  });
}
