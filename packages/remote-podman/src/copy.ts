// ── The actor that copies itself in ────────────────────────────────────────
//
// The other half of the run seam: an actor that is not in the image yet is
// staged first — the kit is written, the runtime that will run it is found — and
// then run by that runtime.  It is a prepare plus a command, so it is built on
// the connector and nothing else.

import type { ClientSpawner } from "posipaki/remote";
import { GATEWAY_ARTIFACT, PAYLOAD_ARTIFACT } from "./commands.js";
import { podmanConnector } from "./connect.js";
import type { PodmanConnectOptions } from "./connect.js";
import type { ContainerSpec, KitSpec, PodmanStaged } from "./spec.js";
import { podmanStage } from "./stage.js";

/** What the copy shape adds to the connector: the actor's own arguments. */
export interface PodmanCopyOptions<Args> extends PodmanConnectOptions {
  /**
   * The payload's own arguments, built from the args the actor was spawned with.
   * This package knows where the payload is and how it is started, not what it
   * wants to be told.
   */
  args?: (args: Args, staged: PodmanStaged) => string[];
}

/**
 * Run an actor in a container, staging the bundle into it first.  Every spawn
 * stages: the far side probes, so a kit that is already there is not written
 * again.  The container is somebody else's to keep alive — see container.ts for
 * the actor that holds one, and environment.ts for both together.
 */
export function podmanCopy<Args>(
  spec: ContainerSpec & KitSpec,
  options: PodmanCopyOptions<Args> = {},
): ClientSpawner<Args> {
  return podmanConnector<Args, PodmanStaged>(
    {
      container: spec.container,
      prepare: ({ container, run }) => podmanStage(container, spec, run),
      command: (args, staged) => {
        const payload = `${staged.kitDir}/${PAYLOAD_ARTIFACT}`;
        const own = options.args?.(args, staged) ?? [];
        if (spec.relay) {
          return [staged.runtime, `${staged.kitDir}/${GATEWAY_ARTIFACT}`, ...own, `--worker=${payload}`];
        }
        return [staged.runtime, payload, ...own];
      },
    },
    options,
  );
}
