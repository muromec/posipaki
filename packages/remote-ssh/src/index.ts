// ── posipaki-remote-ssh ────────────────────────────────────────────────────
//
// Run a posipaki actor on another machine, over ssh.  This package is the way
// in: it stages a kit through one `ssh` channel and runs the actor through a
// second one, whose own stdin/stdout are the wire.  The wire, the kit
// vocabulary and the gateway are posipaki's (`posipaki/remote/node`); what
// lives here is the ssh half — the commands, the kit, and how a spawn is made.

export {
  GATEWAY_ARTIFACT,
  PAYLOAD_ARTIFACT,
  sshEntry,
  sshRunCommand,
  sshStageCommand,
} from "./commands.js";
export { sshKit } from "./kit.js";
export { SshSpecError } from "./spec.js";
export type { SshSpec, SshStaged } from "./spec.js";
