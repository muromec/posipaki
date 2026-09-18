// ── The commands into a container ──────────────────────────────────────────
//
// Two kinds, both built here and asserted as data: the one shape a command reaches an
// *existing* container in (`podman exec -i <name> <command…>`), which is what every run of
// an actor goes through — the staging script first, the gateway after it; and the commands
// that ask about, keep alive and remove a container, which is the lifetime's business (see
// lifetime.ts).
//
// Nothing in this file talks to podman, so every shape is testable without a container.

import type { ContainerSpec } from "./spec.js";

/** One channel into the container.  `-i` because the wire is on stdin. */
export function podmanEntry(container: string, argv: string[]): string[] {
  return ["podman", "exec", "-i", container, ...argv];
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
