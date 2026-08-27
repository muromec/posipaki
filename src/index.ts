/**
 * Posipaki — Erlang-inspired lightweight actor processes built on
 * generator functions. Processes communicate via message-passing,
 * can fork children, and expose their state reactively.
 *
 * @module
 */

import { Process, spawn } from "./process.js";
import { runDispatch } from "./util.js";
import { AsyncProcess, spawnAsync, runDispatchAsync } from "./process.async.js";
import { asyncify } from "./adapters.js";

export { Process, spawn, runDispatch };
export { AsyncProcess, spawnAsync, runDispatchAsync, asyncify };
export type { AnyProcess } from "./process.async.js";

export type {
  Message,
  WithSender,
  WithoutSender,
  ExitMessage,
  StopMessage,
  ProcessFn,
  ProcessCtx,
  AsyncProcessFn,
  SenderOrigin,
  SenderInfo,
} from "./types.js";

export { defineActor, defineMessages } from "./define-actor.js";
export type {
  ActorDefinition,
  SpawnedFrom,
  ActorConfig,
  ActorContext,
  MethodOptions,
  HandlerOptions,
  HandlerFn,
} from "./actor-types.js";

// ── hooks ─────────────────────────────────────────────────────────────────

export { stopPropagation, mergeConfigs, chainHook, callHook } from "./hooks.js";
export type {
  HookResult,
  ActorPlugin,
  ActorDecorated,
  ActorReflection,
  PluginTransform,
} from "./hooks.js";
