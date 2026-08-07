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
} from "./types.js";

export { defineActor, defineMessages } from "./define-actor.js";
export type {
  ActorDefinition,
  ActorConfig,
  ActorContext,
  MethodOptions,
  HandlerOptions,
  HandlerFn,
} from "./actor-types.js";

// ── hooks ─────────────────────────────────────────────────────────────────

export { stopPropagation, HookRegistry } from "./hooks.js";
export type {
  HookResult,
  OnStartHook,
  OnMessageHook,
  OnEmitHook,
  OnChildExitHook,
  OnStopRequestedHook,
  OnEndHook,
  OnErrorHook,
  ActorPlugin,
  ActorDecorated,
  PluginTransform,
} from "./hooks.js";
