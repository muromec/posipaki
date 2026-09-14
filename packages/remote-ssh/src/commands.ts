// ── The commands into a host ───────────────────────────────────────────────
//
// Two channels into the same host, both `ssh <host> …`:
//
//   stage  the bootstrap script arrives on stdin, so nothing else can be there;
//   run    the staged kit, whose own stdin/stdout *are* the wire.
//
// A kit cannot be staged and run on one channel: while the script is on stdin
// the wire cannot be, so the payload gets a second connection into the same home.

import type { SshSpec, SshStaged } from "./spec.js";

/** The names a staged kit's artifacts get inside the kit directory. */
export const PAYLOAD_ARTIFACT = "payload.js";
export const GATEWAY_ARTIFACT = "gateway.js";

/** One channel into the host, as ssh takes it. */
export function sshEntry(spec: SshSpec, argv: string[]): string[] {
  return ["ssh", spec.host, ...argv];
}

/** The bootstrap channel.  The script is fed to it; nothing else may be. */
export function sshStageCommand(spec: SshSpec): string[] {
  return sshEntry(spec, ["sh", "-s"]);
}

/**
 * The run channel: the staged kit, with its own stdin/stdout as the wire.
 * `args` are the payload's own — this package does not know what they mean, only
 * that the payload comes first and, when relaying, the gateway does and names it.
 */
export function sshRunCommand(spec: SshSpec, staged: SshStaged, args: string[]): string[] {
  const { kitDir, runtime } = staged;
  if (spec.relay) {
    return sshEntry(spec, [
      runtime,
      `${kitDir}/${GATEWAY_ARTIFACT}`,
      ...args,
      `--worker=${kitDir}/${PAYLOAD_ARTIFACT}`,
    ]);
  }
  return sshEntry(spec, [runtime, `${kitDir}/${PAYLOAD_ARTIFACT}`, ...args]);
}
