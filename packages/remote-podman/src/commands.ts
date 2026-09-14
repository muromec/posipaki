// ── The commands into a container ──────────────────────────────────────────
//
// Two channels into the same container, both `podman exec -i <name> …`:
//
//   stage  the bootstrap script arrives on stdin, so nothing else can be there;
//   run    the staged kit, whose own stdin/stdout *are* the wire.
//
// A kit cannot be staged and run on one channel: while the script is on stdin the
// wire cannot be, so the payload gets a second `exec` into the container that is
// already up.  The container's own life is three more commands — see lifetime.ts.

import type { PodmanSpec, PodmanStaged } from "./spec.js";

/** The names a staged kit's artifacts get inside the kit directory. */
export const PAYLOAD_ARTIFACT = "payload.js";
export const GATEWAY_ARTIFACT = "gateway.js";

/** One channel into the container.  `-i` because the wire is on stdin. */
export function podmanEntry(spec: PodmanSpec, argv: string[]): string[] {
  return ["podman", "exec", "-i", spec.container, ...argv];
}

/** The bootstrap channel.  The script is fed to it; nothing else may be. */
export function podmanStageCommand(spec: PodmanSpec): string[] {
  return podmanEntry(spec, ["sh", "-s"]);
}

/**
 * The run channel: the staged kit, with its own stdin/stdout as the wire.
 * `args` are the payload's own — this package does not know what they mean, only
 * that the payload comes first and, when relaying, the gateway does and names it.
 */
export function podmanRunCommand(
  spec: PodmanSpec,
  staged: PodmanStaged,
  args: string[],
): string[] {
  const { kitDir, runtime } = staged;
  if (spec.relay) {
    return podmanEntry(spec, [
      runtime,
      `${kitDir}/${GATEWAY_ARTIFACT}`,
      ...args,
      `--worker=${kitDir}/${PAYLOAD_ARTIFACT}`,
    ]);
  }
  return podmanEntry(spec, [runtime, `${kitDir}/${PAYLOAD_ARTIFACT}`, ...args]);
}

/**
 * The container's lifetime handle: an *attached* `podman run` whose main process
 * does nothing but read its stdin.  We hold the other end and never write to it, so
 * the container stays up while we live and goes, `--rm` and all, when we do — by
 * any route, including SIGKILL.
 */
export function containerKeepaliveCommand(spec: PodmanSpec): string[] {
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

/** Is the container there?  (Its own exit code is the answer.) */
export function containerExistsCommand(spec: PodmanSpec): string[] {
  return ["podman", "container", "exists", spec.container];
}

/** Take down a container we are not holding — a stale one from an older process. */
export function containerRemoveCommand(spec: PodmanSpec): string[] {
  return ["podman", "rm", "-f", spec.container];
}
