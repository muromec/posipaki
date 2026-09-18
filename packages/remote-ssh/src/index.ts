// ── posipaki-remote-ssh ────────────────────────────────────────────────────
//
// Run a posipaki actor on a host you reach over ssh.  A way in is a way in: what lives here
// is the ssh half — a host, and the one command shape — and the payload, the gateway, the
// kit, the runtime that runs it and the wire are posipaki's (`posipaki/remote/node`, where
// `gatewayClient` turns an `entry` into a spawner).
//
// The ssh process is the lifetime: nothing is created ahead of the command or left behind
// after it.  `posipaki-remote-podman` is the one with a container to hand over.

export { sshEntry } from "./commands.js";
export { sshRemote } from "./remote.js";
export { SshSpecError } from "./spec.js";
export type { KitApp, SshRemoteSpec } from "./spec.js";
