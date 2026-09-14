// ── posipaki-remote-podman ─────────────────────────────────────────────────
//
// Run a posipaki actor in a podman container.  The pieces are deliberately
// separate, because a container's life and a way into it are two things:
//
//   containerActor   a container, as an actor: it starts one, holds it, counts
//                    the consumers that retain it, and lets it go at the end
//   podmanConnector  the way in by name: a prepare step (optional) and a command,
//                    on the exec's own stdin/stdout.  No container, no channel
//   podmanBootstrap  the connector with the actor's bundle staged into it first
//   podmanEnvironment  both together: a container of its own per actor
//
// The wire, the kit vocabulary and the gateway are posipaki's
// (`posipaki/remote/node`); what lives here is the container half.

export {
  GATEWAY_ARTIFACT,
  PAYLOAD_ARTIFACT,
  containerExistsCommand,
  containerKeepaliveCommand,
  containerRemoveCommand,
  podmanEntry,
  podmanStageCommand,
} from "./commands.js";
export { runHost, spawnChild } from "./host.js";
export type { HostResult, HostRun, SpawnChild } from "./host.js";
export { podmanKit } from "./kit.js";
export {
  CONTAINER_REAP_MS,
  CONTAINER_START_MS,
  containerExists,
  removeContainer,
  startContainer,
  startHost,
  stopContainer,
} from "./lifetime.js";
export type {
  ConflictPolicy,
  ContainerHandle,
  ContainerLifeOptions,
  ContainerStartResult,
  HostStart,
} from "./lifetime.js";
export { containerActor, holdContainer } from "./container.js";
export type { ContainerActorArgs, ContainerIn, ContainerOut } from "./container.js";
export { podmanConnector } from "./connect.js";
export type { PodmanConnectOptions, PodmanConnectSpec, PodmanPrepare } from "./connect.js";
export { podmanBootstrap } from "./bootstrap.js";
export { podmanEnvironment } from "./environment.js";
export type { PodmanEnvironmentOptions } from "./environment.js";
export { PodmanSpecError } from "./spec.js";
export type { ContainerSpec, KitSpec, PodmanStaged } from "./spec.js";
export { podmanStage } from "./stage.js";
