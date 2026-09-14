// ── posipaki-remote-ssh ────────────────────────────────────────────────────
//
// Run a posipaki actor on another machine, over ssh.  This package is the way
// in, in two pieces: the *connector*, which opens a channel to a host that is
// already there and runs a command on it, and the *copy*, which stages the kit
// onto that host first and then runs it.  The wire, the kit vocabulary and the
// gateway are posipaki's (`posipaki/remote/node`); what lives here is the ssh
// half — the commands, the kit, the staging, the channel.
//
// There is no environment of its own here, and nothing is started or stopped:
// the ssh process *is* the lifetime.  Compare `posipaki-remote-podman`, where a
// container has one to hand over — four pieces there, two here, and the same
// two knobs in both.

export {
  GATEWAY_ARTIFACT,
  PAYLOAD_ARTIFACT,
  sshEntry,
  sshStageCommand,
} from "./commands.js";
export { sshConnector } from "./connect.js";
export type { SshConnectOptions, SshConnectSpec, SshPrepare } from "./connect.js";
export { sshCopy } from "./copy.js";
export type { SshCopyOptions } from "./copy.js";
export { runHost, spawnChild } from "./host.js";
export type { HostResult, HostRun, SpawnChild } from "./host.js";
export { sshKit } from "./kit.js";
export { SshSpecError } from "./spec.js";
export type { KitSpec, SshHostSpec, SshSpec, SshStaged } from "./spec.js";
export { sshStage } from "./stage.js";
