// ── The command into a sandbox ─────────────────────────────────────────────
//
// The one thing this package knows that posipaki does not: a command reaches bwrap as
// `bwrap <policy> <command…>`.  Everything this package runs goes through here — the
// staging script (`sh -s`, the kit fed to it on stdin) and the gateway that follows — so
// there is exactly one place where the policy meets a command.
//
// It is built and asserted as data: nothing in this file talks to bwrap, so the shape is
// testable without a sandbox.

/** The sandbox: what it is called where errors are reported, and the arguments that shape it. */
export interface Sandbox {
  name: string;
  args: string[];
}

/** The policy, then the command: the one shape bwrap is reached in. */
export function bwrapEntry(args: string[], command: string[]): string[] {
  return ["bwrap", ...args, ...command];
}
