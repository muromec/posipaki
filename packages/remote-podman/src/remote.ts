// ── The way in ─────────────────────────────────────────────────────────────
//
// Everything below the entry is posipaki's: the payload and posipaki's gateway are staged
// through this same container, the gateway makes its fifo inside it, and the client speaks
// the wire over the exec's own stdin/stdout.  All this package says is what a command looks
// like on the way in — and the container is somebody else's to keep alive (see container.ts
// for the actor that holds one, and environment.ts for both together).

import type { ClientSpawner } from "posipaki/remote";
import { gatewayClient } from "posipaki/remote/node";
import { podmanEntry } from "./commands.js";
import type { PodmanRemoteSpec } from "./spec.js";

/**
 * Run a posipaki actor in an existing container.
 *
 * Every spawn stages: the far side probes, so a kit that is already there — the same app
 * and the same build — is not written again, and a spawn of it costs one exec and no copy.
 */
export function podmanRemote<Args>(spec: PodmanRemoteSpec<Args>): ClientSpawner<Args> {
  return gatewayClient({
    ...spec,
    name: spec.name ?? spec.container,
    entry: (command) => podmanEntry(spec.container, command),
  });
}
