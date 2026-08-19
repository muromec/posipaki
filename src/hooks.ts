// ── Lifecycle Hooks ──────────────────────────────────────────────────────
//
// Extends ProcessCtx and defineActor with observable lifecycle hooks.
// Hooks are additive — multiple callbacks can register for the same hook
// point, and they fire in registration order.

import { STOP_SENTINEL, stopPropagation } from "./actor-types.js";
import type {
  HookResult,
  ActorPlugin,
  PluginTransform,
  AnyConfig,
} from "./actor-types.js";

// ── stop propagation sentinel ────────────────────────────────────────────

// Re-exports from actor-types.ts (backward compatibility)
export { STOP_SENTINEL, stopPropagation };
export type { HookResult, ActorPlugin, PluginTransform };

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
export interface ActorReflection {}

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
  existing:
    | ((this: TThis, ...args: TArgs) => HookResult | Promise<HookResult>)
    | undefined,
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
 *     beforeEnd() { this.log.info('stopping'); },
 *   });
 *
 * @param base    - the existing config (ActorConfig)
 * @param overlay - new hook implementations to prepend
 * @returns a new config with hooks chained
 */
export function mergeConfigs<C extends AnyConfig>(base: C, overlay: Partial<C>): C {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(overlay as Record<string, unknown>)) {
    const val = (overlay as Record<string, unknown>)[key];
    if (typeof val === "function" && /^(on|after|before)[A-Z]/.test(key)) {
      result[key] = chainHook(
        (base as Record<string, unknown>)[key] as (
          this: unknown,
          ...args: unknown[]
        ) => HookResult | Promise<HookResult>,
        val as (
          this: unknown,
          ...args: unknown[]
        ) => HookResult | Promise<HookResult>,
      );
    } else {
      result[key] = val;
    }
  }
  result.$reflectionMethods = {};
  Object.assign(
    result.$reflectionMethods as object,
    "$reflectionMethods" in base ? base.$reflectionMethods : {},
    "$reflectionMethods" in overlay ? overlay.$reflectionMethods : {},
  );

  return result as unknown as C;
}

export type Hook<T, I extends unknown[], O> = (this: T, ...args: I) => O;

export async function callHook<T, I extends unknown[], O>(
  fn: Hook<T, I, O> | undefined,
  eh: ((e: unknown) => unknown) | undefined,
  thisArg: T,
  ...args: I
): Promise<O | undefined> {
  if (fn) {
    try {
      return await fn.call(thisArg, ...args);
    } catch (e) {
      if (eh) {
        try {
          await eh(e);
        } catch {}
      } else {
        throw e;
      }
    }
  }
  return undefined;
}
