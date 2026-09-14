// ── posipaki-remote-podman ─────────────────────────────────────────────────
//
// Run a posipaki actor inside a podman container.  This package is the way in: it
// keeps the container alive for as long as the caller is, stages a kit into it over
// one `exec` and runs the actor over a second one, whose own stdin/stdout are the
// wire.  The wire, the kit vocabulary and the gateway are posipaki's
// (`posipaki/remote/node`); what lives here is the container half.

export {
  GATEWAY_ARTIFACT,
  PAYLOAD_ARTIFACT,
  containerExistsCommand,
  containerKeepaliveCommand,
  containerRemoveCommand,
  podmanEntry,
  podmanRunCommand,
  podmanStageCommand,
} from "./commands.js";
export { runHost, spawnChild } from "./host.js";
export type { HostResult, HostRun, SpawnChild } from "./host.js";
export { podmanKit } from "./kit.js";
export {
  CONTAINER_START_MS,
  ensureContainer,
  removeContainer,
  startHost,
  stopContainer,
} from "./lifetime.js";
export type { ContainerHandle, HostStart, PodmanLifetimeOptions } from "./lifetime.js";
export { podmanSpawner } from "./spawner.js";
export type { PodmanSpawnerOptions, PodmanWireOptions } from "./spawner.js";
export { PodmanSpecError } from "./spec.js";
export type { PodmanSpec, PodmanStaged } from "./spec.js";
export { podmanStage } from "./stage.js";
