// ── The commands into a sandbox ────────────────────────────────────────────
//
// Two channels into the same sandbox, both `bwrap <args> …`:
//
//   prepare  the bootstrap script arrives on stdin, so nothing else can be there;
//   run      the actor, whose own stdin/stdout *are* the wire.
//
// Both are bwrap invocations, and each one builds its own namespaces: there is no
// sandbox "container" that both enter, only the same policy applied twice.  That
// is why nothing here is long-lived and why `--die-with-parent` is enough — when
// we go, the last process on the other side of the wire goes with us.
//
// Every command is built here and asserted as data: nothing in this file talks to
// bwrap, so a shape is testable without a sandbox.

import type { SandboxSpec } from "./spec.js";

/** The names a staged kit's artifacts get inside the kit directory. */
export const PAYLOAD_ARTIFACT = "payload.js";
export const GATEWAY_ARTIFACT = "gateway.js";

/** One channel into the sandbox: the policy, then the command. */
export function bwrapEntry(sandbox: SandboxSpec, argv: string[]): string[] {
  return ["bwrap", ...sandbox.args, ...argv];
}

/** The preparing channel.  The script is fed to it; nothing else may be. */
export function bwrapStageCommand(sandbox: SandboxSpec): string[] {
  return bwrapEntry(sandbox, ["sh", "-s"]);
}
