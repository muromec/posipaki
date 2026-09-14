// ── posipaki-remote-bwrap ──────────────────────────────────────────────────
//
// Run a posipaki actor in a bubblewrap sandbox, on this machine.  This package is
// the way in, in two pieces: the *connector*, which applies a policy and runs a
// command inside it, and the *bootstrap*, which stages the kit in there first and
// then runs it.  The wire, the kit vocabulary and the gateway are posipaki's
// (`posipaki/remote/node`); what lives here is the bwrap half — the policy, the
// commands, the kit, the staging, the channel.
//
// There is no environment of its own here, and nothing to start or hold: the
// sandbox is made by bwrap for exactly as long as the command runs.  Compare
// `posipaki-remote-podman`, where a container has a lifetime to hand over — four
// pieces there, two here and in `posipaki-remote-ssh`, with the same two knobs in
// all three.

export { GATEWAY_ARTIFACT, PAYLOAD_ARTIFACT, bwrapEntry, bwrapStageCommand } from "./commands.js";
export { bwrapConnector } from "./connect.js";
export type { BwrapConnectOptions, BwrapConnectSpec, BwrapPrepare } from "./connect.js";
export { bwrapBootstrap } from "./bootstrap.js";
export type { BwrapBootstrapOptions } from "./bootstrap.js";
export { runHost, spawnChild } from "./host.js";
export type { HostResult, HostRun, SpawnChild } from "./host.js";
export { bwrapKit } from "./kit.js";
export { sandboxArgs } from "./sandbox.js";
export type { SandboxPolicy } from "./sandbox.js";
export { BwrapSpecError } from "./spec.js";
export type { BwrapSpec, BwrapStaged, KitSpec, SandboxSpec } from "./spec.js";
export { bwrapStage } from "./stage.js";
