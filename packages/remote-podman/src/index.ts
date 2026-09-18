// ── posipaki-remote-podman ─────────────────────────────────────────────────
//
// Run a posipaki actor in a podman container.  The pieces are deliberately
// separate, because a container's life and a way into it are two things:
//
//   containerActor   a container, as an actor: it starts one, holds it, counts
//                    the consumers that retain it, and lets it go at the end
//   podmanRemote     the way in by name: the actor staged *into* a container that is
//                    already there, over the exec's own stdin/stdout
//   podmanEnvironment  both together: a container of its own per actor
//
// The payload, the gateway, the kit, the runtime and the wire are posipaki's
// (`posipaki/remote/node`, where `gatewayClient` turns an `entry` into a spawner); what
// lives here is the container half — its life, and the one command shape.

export {
  containerExistsCommand,
  containerKeepaliveCommand,
  containerRemoveCommand,
  podmanEntry,
} from "./commands.js";
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
export { podmanRemote } from "./remote.js";
export { podmanEnvironment } from "./environment.js";
export type { PodmanEnvironmentSpec } from "./environment.js";
export { PodmanSpecError } from "./spec.js";
export type { ContainerSpec, KitApp, PodmanRemoteSpec } from "./spec.js";
