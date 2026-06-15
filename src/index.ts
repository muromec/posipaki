/**
 * Posipaki — Erlang-inspired lightweight actor processes built on
 * generator functions. Processes communicate via message-passing,
 * can fork children, and expose their state reactively.
 *
 * @module
 */

import { Process, spawn } from "./process";
import { runDispatch } from "./util";
import { AsyncProcess, spawnAsync, runDispatchAsync, sendFrom } from "./process.async";
import { asyncify } from "./adapters";

export { Process, spawn, runDispatch };
export { AsyncProcess, spawnAsync, runDispatchAsync, asyncify, sendFrom };

export type {
  Message,
  WithSender,
  WithoutSender,
  ExitMessage,
  StopMessage,
  ProcessFn,
  ProcessCtx,
  AsyncProcessFn,
  PipeState,
  SupervisorState,
  SenderOrigin,
  SenderInfo,
} from "./types";

export { defineActor, defineMessages } from "./define-actor.js";
export type {
  ActorDefinition,
  ActorConfig,
  ActorContext,
  MethodOptions,
  HandlerOptions,
  HandlerFn,
} from "./actor-types.js";
