// ── The kit a sandbox environment is handed ────────────────────────────────
//
// Deliberately a twin of the ssh and podman packages' kits: a way in is a way in,
// and the three are not abstracted over (the duplication is the design).  What
// travels is the consumer's build output, read here and named inside the kit; how
// it is written on the far side is the core's bootstrap script.

import { readFile } from "node:fs/promises";
import { DEFAULT_KIT_PARENT, DEFAULT_RUNTIMES, makeKit } from "posipaki/remote/node";
import type { Kit } from "posipaki/remote/node";
import { GATEWAY_ARTIFACT, PAYLOAD_ARTIFACT } from "./commands.js";
import { BwrapSpecError } from "./spec.js";
import type { KitSpec } from "./spec.js";

/**
 * The kit this spec ships: the payload always, the gateway when the shape relays
 * — a gateway without one has nothing to relay to.
 */
export async function bwrapKit(spec: KitSpec): Promise<Kit> {
  const files = [{ name: PAYLOAD_ARTIFACT, content: await readFile(spec.payload) }];
  if (spec.relay) {
    if (!spec.gateway) {
      throw new BwrapSpecError("a relayed kit needs a gateway bundle — nothing to relay to");
    }
    files.push({ name: GATEWAY_ARTIFACT, content: await readFile(spec.gateway) });
  }
  return makeKit(files, {
    app: spec.app,
    runtimes: spec.runtime ?? DEFAULT_RUNTIMES,
    parent: spec.parent ?? DEFAULT_KIT_PARENT,
  });
}
