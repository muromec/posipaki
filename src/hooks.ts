// ── Lifecycle Hooks ──────────────────────────────────────────────────────
//
// Extends ProcessCtx and defineActor with observable lifecycle hooks.
// Hooks are additive — multiple callbacks can register for the same hook
// point, and they fire in registration order.

import type { Message, SenderInfo } from './types.js';

// ── stop propagation sentinel ────────────────────────────────────────────

/** Returned by onMessage hooks to prevent further dispatch. */
export const STOP_SENTINEL = Symbol('posipaki.stopPropagation');

/** Type-safe sentinel for short-circuiting onMessage hooks. */
export const stopPropagation = (): typeof STOP_SENTINEL => STOP_SENTINEL;

/** Return type of onMessage hooks: void (continue) or sentinel (stop). */
export type HookResult = void | typeof STOP_SENTINEL;

// ── hook function types ──────────────────────────────────────────────────

export type OnStartHook<State> = (state: State) => void | Promise<void>;
export type OnMessageHook<InMsg extends Message> = (msg: InMsg, sender: SenderInfo) => HookResult | Promise<HookResult>;
export type OnEmitHook<OutMsg extends Message> = (msg: OutMsg) => void;
export type OnChildExitHook = (name: string) => void | Promise<void>;
export type OnStopRequestedHook = () => void | Promise<void>;
export type OnEndHook = (reason: unknown) => void | Promise<void>;
export type OnErrorHook = (err: unknown) => void;

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

// ── plugin types ─────────────────────────────────────────────────────────

import type { ProcessCtx } from './types.js';
import type { Message } from './types.js';

/** A reusable unit of actor behaviour, installed at fork time. */
export interface ActorPlugin {
  name: string;
  install(ctx: ProcessCtx<any, any, any, any>): void | Promise<void>;
}

/** Transform parent plugins into child plugins. */
export type PluginTransform = (parentPlugins: ActorPlugin[]) => ActorPlugin[];
