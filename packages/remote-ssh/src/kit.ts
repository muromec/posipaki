// ── The kit an ssh environment is handed ───────────────────────────────────
//
// What travels is the consumer's build output, read here and named inside the
// kit; how it is written on the host (probe, write only what is missing, report)
// is the core's script.  This module is the short half in between: which files
// belong in the kit, and under which names.

import { readFile } from "node:fs/promises";
import { DEFAULT_KIT_PARENT, DEFAULT_RUNTIMES, makeKit } from "posipaki/remote/node";
import type { Kit } from "posipaki/remote/node";
import { GATEWAY_ARTIFACT, PAYLOAD_ARTIFACT } from "./commands.js";
import { SshSpecError } from "./spec.js";
import type { SshSpec } from "./spec.js";

/**
 * The kit this spec ships: the payload always, the gateway when the shape
 * relays — a gateway without one has nothing to relay to.
 */
export async function sshKit(spec: SshSpec): Promise<Kit> {
  const files = [{ name: PAYLOAD_ARTIFACT, content: await readFile(spec.payload) }];
  if (spec.relay) {
    if (!spec.gateway) {
      throw new SshSpecError("a relayed kit needs a gateway bundle — nothing to relay to");
    }
    files.push({ name: GATEWAY_ARTIFACT, content: await readFile(spec.gateway) });
  }
  return makeKit(files, {
    app: spec.app,
    runtimes: spec.runtime ?? DEFAULT_RUNTIMES,
    parent: spec.parent ?? DEFAULT_KIT_PARENT,
  });
}
