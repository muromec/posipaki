// ── posipaki-remote-ssh ────────────────────────────────────────────────────
//
// Run a posipaki actor on another machine, over ssh.  This package is the way
// in, in two pieces: the *connector*, which opens a channel to a host that is
// already there and runs a command on it, and the *bootstrap*, which stages the
// kit onto that host first and then runs it.  The wire, the kit vocabulary and the
// gateway are posipaki's (`posipaki/remote/node`); what lives here is the ssh
// half — the commands, the kit, the staging, the channel.
//
// The ssh process *is* the lifetime: ssh starts nothing and holds nothing, which
// is why this package has two pieces where `posipaki-remote-podman` has four.
// Both come down to the same two knobs — a `prepare` and a `command`.

export {
  GATEWAY_ARTIFACT,
  PAYLOAD_ARTIFACT,
  sshEntry,
  sshStageCommand,
} from "./commands.js";
export { sshConnector } from "./connect.js";
export type { SshConnectOptions, SshConnectSpec, SshPrepare } from "./connect.js";
export { sshBootstrap } from "./bootstrap.js";
export type { SshBootstrapOptions } from "./bootstrap.js";
export { runHost, spawnChild } from "./host.js";
export type { HostResult, HostRun, SpawnChild } from "./host.js";
export { sshKit } from "./kit.js";
export { SshSpecError } from "./spec.js";
export type { KitSpec, SshHostSpec, SshSpec, SshStaged } from "./spec.js";
export { sshStage } from "./stage.js";
