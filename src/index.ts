/**
 * Posipaki — Erlang-inspired lightweight actor processes built on
 * generator functions. Processes communicate via message-passing,
 * can fork children, and expose their state reactively.
 *
 * @module
 */

import { Process, spawn } from "./process"
import { runDispatch } from "./util"
import { AsyncProcess, spawnAsync, runDispatchAsync } from "./process.async"
import { asyncify } from "./adapters"

export { Process, spawn, runDispatch }
export { AsyncProcess, spawnAsync, runDispatchAsync, asyncify }

export type {
  Message, ExitMessage, ProcessFn, ProcessCtx,
  AsyncProcessFn, PipeState, SupervisorState,
} from "./types"

export { defineActor } from "./define-actor.js"
export type { ActorDefinition, ActorConfig, ActorContext } from "./actor-types.js"
