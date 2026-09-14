// ── The commands into a container ──────────────────────────────────────────
//
// Two channels into the same container, both `podman exec -i <name> …`:
//
//   prepare  the bootstrap script arrives on stdin, so nothing else can be there;
//   run      the actor, whose own stdin/stdout *are* the wire.
//
// A kit cannot be staged and run on one channel: while the script is on stdin the
// wire cannot be, so the actor gets a second `exec` into the container.  The
// container's own life is three more commands — see lifetime.ts.
//
// Every command is built here and asserted as data: nothing in this file talks to
// podman, so a shape is testable without a container.

import type { ContainerSpec } from "./spec.js";

/** The names a staged kit's artifacts get inside the kit directory. */
export const PAYLOAD_ARTIFACT = "payload.js";
export const GATEWAY_ARTIFACT = "gateway.js";

/** One channel into the container.  `-i` because the wire is on stdin. */
export function podmanEntry(container: string, argv: string[]): string[] {
  return ["podman", "exec", "-i", container, ...argv];
}

/** The preparing channel.  The script is fed to it; nothing else may be. */
export function podmanStageCommand(container: string): string[] {
  return podmanEntry(container, ["sh", "-s"]);
}

/**
 * The container's lifetime handle: an *attached* `podman run` whose main process
 * does nothing but read its stdin.  We hold the other end and never write to it, so
 * the container stays up while we live and goes, `--rm` and all, when we do — by
 * any route, including SIGKILL.
 */
export function containerKeepaliveCommand(spec: ContainerSpec): string[] {
  return [
    "podman",
    "run",
    "--rm",
    "-i",
    "--name",
    spec.container,
    spec.image,
    "sh",
    "-c",
    "cat >/dev/null",
  ];
}

/** Is there a container by that name — whoever started it. */
export function containerExistsCommand(container: string): string[] {
  return ["podman", "container", "exists", container];
}

/** Take a container down by name, whether or not we are holding it. */
export function containerRemoveCommand(container: string): string[] {
  return ["podman", "rm", "-f", container];
}
