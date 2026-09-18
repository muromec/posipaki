// ── posipaki-remote-bwrap ──────────────────────────────────────────────────
//
// Run a posipaki actor in a bubblewrap sandbox, on this machine.  A way in is a way in:
// what lives here is the bwrap half — the policy, and the one command shape — and the
// payload, the gateway, the kit, the runtime that runs it and the wire are posipaki's
// (`posipaki/remote/node`, where `gatewayClient` turns an `entry` into a spawner).
//
// The sandbox is made by bwrap for exactly as long as the command runs, which leaves
// nothing to start, hold or clean up.  `posipaki-remote-podman` is the one with a lifetime
// to hand over, and `posipaki-remote-ssh` is the same shape as this one, on someone else's
// machine.

export { bwrapEntry } from "./commands.js";
export type { Sandbox } from "./commands.js";
export { bwrapRemote } from "./remote.js";
export { sandboxArgs } from "./sandbox.js";
export type { SandboxPolicy } from "./sandbox.js";
export { BwrapSpecError } from "./spec.js";
export type { BwrapRemoteSpec, KitApp } from "./spec.js";
