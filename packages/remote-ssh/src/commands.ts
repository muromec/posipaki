// ── The command onto a host ────────────────────────────────────────────────
//
// The one thing this package knows that posipaki does not: a command reaches the far side
// as `ssh <host> <command…>`.  Everything this package runs goes through here — the staging
// script (`sh -s`, the kit fed to it on stdin) and the gateway that follows — so there is
// exactly one place where the host meets a command.
//
// A kit cannot be staged and run on one connection: while the script is on stdin the wire
// cannot be, so the gateway gets a second `ssh` into the same home.  That is the connector's
// business, not this file's — here a command is data, testable without a host.

/** The argv that runs a command on the host, as ssh takes it. */
export function sshEntry(host: string, command: string[]): string[] {
  return ["ssh", host, ...command];
}
