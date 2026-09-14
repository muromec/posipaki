// ── The commands into a host ───────────────────────────────────────────────
//
// Two channels into the same host, both `ssh <host> …`:
//
//   prepare  the bootstrap script arrives on stdin, so nothing else can be there;
//   run      the actor, whose own stdin/stdout *are* the wire.
//
// A kit cannot be staged and run on one channel: while the script is on stdin the
// wire cannot be, so the actor gets a second connection into the same home.  The
// run's own argv is not built here — it is what a connector's `command` returns,
// which is the one thing that turns one way in into another (see bootstrap.ts).
//
// Every command is built here and asserted as data: nothing in this file talks to
// a host, so a shape is testable without ssh.

import type { SshHostSpec } from "./spec.js";

/** The names a staged kit's artifacts get inside the kit directory. */
export const PAYLOAD_ARTIFACT = "payload.js";
export const GATEWAY_ARTIFACT = "gateway.js";

/** One channel into the host, as ssh takes it. */
export function sshEntry(host: string, argv: string[]): string[] {
  return ["ssh", host, ...argv];
}

/** The preparing channel.  The script is fed to it; nothing else may be. */
export function sshStageCommand(spec: SshHostSpec): string[] {
  return sshEntry(spec.host, ["sh", "-s"]);
}
