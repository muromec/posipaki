// ── Lifecycle Hooks ──────────────────────────────────────────────────────
//
// Extends ProcessCtx and defineActor with observable lifecycle hooks.
// Hooks are additive — multiple callbacks can register for the same hook
// point, and they fire in registration order.

import type { Message } from './types.js';
import {
  STOP_SENTINEL,
  stopPropagation,
} from './actor-types.js';
import type {
  HookResult,
  OnStartHook,
  OnMessageHook,
  OnEmitHook,
  OnChildExitHook,
  OnStopRequestedHook,
  OnEndHook,
  OnErrorHook,
  ActorPlugin,
  PluginTransform,
} from './actor-types.js';

// ── stop propagation sentinel ────────────────────────────────────────────

/** Returned by onMessage hooks to prevent further dispatch. */
// ── hook registry ────────────────────────────────────────────────────────

export class HookRegistry<State, InMsg extends Message, OutMsg extends Message> {
  onStart: Array<OnStartHook<State>> = [];
  onMessage: Array<OnMessageHook<InMsg>> = [];
  onEmit: Array<OnEmitHook<OutMsg>> = [];
  onChildExit: Array<OnChildExitHook> = [];
  onStopRequested: Array<OnStopRequestedHook> = [];
  onEnd: Array<OnEndHook> = [];
  onError: Array<OnErrorHook> = [];
}

// Re-exports from actor-types.ts (backward compatibility)
export { STOP_SENTINEL, stopPropagation };
export type { HookResult, OnStartHook, OnMessageHook, OnEmitHook, OnChildExitHook, OnStopRequestedHook, OnEndHook, OnErrorHook, ActorPlugin, PluginTransform };

// ── type augmentation (Fastify-style) ────────────────────────────────────

/**
 * Interface that plugins can augment via declaration merging.
 * Plugins ship a .d.ts that adds properties to this interface,
 * making them available on `this` in handlers and methods.
 *
 * Example (in a plugin's .d.ts):
 *   declare module 'posipaki' {
 *     interface ActorDecorated {
 *       log: Logger;
 *     }
 *   }
 */
export interface ActorDecorated {}
