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

// ── chainHook ────────────────────────────────────────────────────────────

/**
 * Compose two lifecycle hooks so that `plugin` fires first.
 *
 * If `plugin` returns the STOP_SENTINEL (via stopPropagation()),
 * `existing` is skipped entirely and the sentinel propagates.
 * Otherwise `existing` fires and its return value is used.
 *
 * Typical use in a plugin:
 *   (cfg) => ({ ...cfg, onStart: chainHook(cfg.onStart, myOnStart) })
 *
 * @param existing - the current hook on the config (may be undefined)
 * @param plugin   - the new hook to prepend
 * @returns a composed hook suitable for ActorConfig
 */
export function chainHook<TThis, TArgs extends unknown[]>(
  existing: ((this: TThis, ...args: TArgs) => HookResult | Promise<HookResult>) | undefined,
  plugin: (this: TThis, ...args: TArgs) => HookResult | Promise<HookResult>,
): (this: TThis, ...args: TArgs) => HookResult | Promise<HookResult> {
  if (!existing) return plugin;
  return async function (this: TThis, ...args: TArgs): Promise<HookResult> {
    const result = await plugin.call(this, ...args);
    if (result === STOP_SENTINEL) return result;
    return await existing.call(this, ...args);
  } as (this: TThis, ...args: TArgs) => HookResult | Promise<HookResult>;
}

// ── mergeConfigs ─────────────────────────────────────────────────────────

/**
 * Merge an overlay config into a base config, auto-chaining every on* hook.
 *
 * Each key in `overlay` that starts with "on" followed by an uppercase
 * letter (onStart, onMessage, onEmit, etc.) is composed via chainHook()
 * so that the overlay hook fires before the base hook, and stopPropagation
 * is respected.
 *
 * Typical use in a plugin:
 *   return mergeConfigs(cfg, {
 *     onStart() { this.log.info('starting'); },
 *     onEnd()   { this.log.info('stopping'); },
 *   });
 *
 * @param base    - the existing config (ActorConfig)
 * @param overlay - new hook implementations to prepend
 * @returns a new config with hooks chained
 */
export function mergeConfigs<T>(
  base: T,
  overlay: Partial<T>,
): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(overlay as Record<string, unknown>)) {
    const val = (overlay as Record<string, unknown>)[key];
    if (typeof val === 'function' && /^on[A-Z]/.test(key)) {
      result[key] = chainHook(
        (base as Record<string, unknown>)[key] as (this: unknown, ...args: unknown[]) => HookResult | Promise<HookResult>,
        val as (this: unknown, ...args: unknown[]) => HookResult | Promise<HookResult>,
      );
    } else {
      result[key] = val;
    }
  }
  return result as unknown as T;
}
