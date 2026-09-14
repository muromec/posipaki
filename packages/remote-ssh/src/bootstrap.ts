// ── The actor that copies itself in ────────────────────────────────────────
//
// The other half of the run seam: an actor that is not on the host yet is staged
// first — the kit is written by the bootstrap script, the runtime that will run
// it is found — and then run by that runtime.  It is a prepare plus a command, so
// it is built on the connector and nothing else.

import type { ClientSpawner } from "posipaki/remote";
import { GATEWAY_ARTIFACT, PAYLOAD_ARTIFACT } from "./commands.js";
import { sshConnector } from "./connect.js";
import type { SshConnectOptions } from "./connect.js";
import type { SshSpec, SshStaged } from "./spec.js";
import { sshStage } from "./stage.js";

/** What the bootstrap shape adds to the connector: the actor's own arguments. */
export interface SshBootstrapOptions<Args> extends SshConnectOptions {
  /**
   * The payload's own arguments, built from the args the actor was spawned with.
   * This package knows where the payload is and how it is started, not what it
   * wants to be told.
   */
  args?: (args: Args, staged: SshStaged) => string[];
}

/**
 * Run an actor on a host, staging the kit there first.  Every spawn stages: the
 * far side probes, so a kit that is already there is not written again.  There
 * is nothing to hold here — the ssh process *is* the lifetime, which is why this
 * package has no environment of its own.
 */
export function sshBootstrap<Args>(spec: SshSpec, options: SshBootstrapOptions<Args> = {}): ClientSpawner<Args> {
  return sshConnector<Args, SshStaged>(
    {
      host: spec.host,
      prepare: ({ host, run }) => sshStage({ ...spec, host }, { runHost: run }),
      command: (args, staged) => {
        const payload = `${staged.kitDir}/${PAYLOAD_ARTIFACT}`;
        const own = options.args?.(args, staged) ?? [];
        if (spec.relay) {
          return [
            staged.runtime,
            `${staged.kitDir}/${GATEWAY_ARTIFACT}`,
            ...own,
            `--worker=${payload}`,
          ];
        }
        return [staged.runtime, payload, ...own];
      },
    },
    options,
  );
}
