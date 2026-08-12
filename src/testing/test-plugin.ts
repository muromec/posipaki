// ── Test Plugins ─────────────────────────────────────────────────────────
//
// createCollector: per-actor message collector plugin.
// createRootTracker: global process tracker for cleanup.

import { mergeConfigs, type ActorPlugin } from "../hooks.js";
import type { Message, StopMessage, SenderInfo, ProcessCtx } from "../types.js";
import { toMatcher, type MatchSpec } from "./msg-matcher.js";
import { pnameMatch } from "./pname-match.js";

// ── types ────────────────────────────────────────────────────────────────

export interface MatchResult {
  ok: boolean;
  detail?: string;
}

export interface Collector<M extends Message> {
  plugin: ActorPlugin;
  messages: M[];
  resolved(): Promise<MatchResult>;
  next(filter: MatchSpec<M>): Promise<MatchResult>;
  reset(filter?: MatchSpec<M>): void;
}

export interface RootTracker {
  plugin: ActorPlugin;
  stopAll(): Promise<void>;
}

// ── createCollector ──────────────────────────────────────────────────────

export function createCollector<M extends Message>(
  filter: MatchSpec<M>,
  opts?: { scope?: string | string[] },
): Collector<M> {
  const messages: M[] = [];
  let matcher = toMatcher(filter);
  // Captured from the root's beforeStart; used as the default scope.
  let defaultScope: string[] = [];
  // The plugin is installed on the root first (spawn assembles before any
  // child is forked), so the first install's beforeStart is the root.
  let installed = false;
  let waiters: Array<(result: MatchResult) => void> = [];

  function scopePatterns(): string[] {
    if (opts?.scope === undefined) return defaultScope;
    return Array.isArray(opts.scope) ? opts.scope : [opts.scope];
  }

  function checkAndNotify() {
    const last = messages[messages.length - 1];
    if (last !== undefined && matcher(last, messages)) {
      const ws = waiters.splice(0);
      for (const w of ws) w({ ok: true });
    }
  }

  function resolved(): Promise<MatchResult> {
    return new Promise((resolve) => {
      const last = messages[messages.length - 1];
      if (last !== undefined && matcher(last, messages)) {
        resolve({ ok: true });
        return;
      }
      waiters.push(resolve);
    });
  }

  const collectorPlugin: ActorPlugin = (config) => {
    const isRoot = !installed;
    installed = true;
    return mergeConfigs(config, {
      beforeStart() {
        if (isRoot) defaultScope = [this.name];
      },
      onEmit(msg: Message, sender: SenderInfo) {
        if (!pnameMatch(sender.fromName, scopePatterns())) return;
        messages.push(msg as M);
        checkAndNotify();
      },
      onEnd() {
        const ws = waiters.splice(0);
        for (const w of ws) w({ ok: false, detail: "actor exited before match" });
      },
    });
  };

  // Named function so framework deduplication works.
  Object.defineProperty(collectorPlugin, "name", { value: "messageCollector" });

  return {
    plugin: collectorPlugin,
    messages,
    resolved,
    next(nextFilter) {
      matcher = toMatcher(nextFilter);
      return resolved();
    },
    reset(newFilter) {
      if (newFilter) matcher = toMatcher(newFilter);
    },
  };
}

// ── createRootTracker ────────────────────────────────────────────────────

export function createRootTracker(): RootTracker {
  const roots = new Set<{ sendSelf: (msg: StopMessage) => void }>();

  const rootTrackerPlugin: ActorPlugin = (config) =>
    mergeConfigs(config, {
      beforeStart(this: { ctx: ProcessCtx<unknown, unknown, Message, Message> }) {
        roots.add(this.ctx);
      },
      onEnd(this: { ctx: ProcessCtx<unknown, unknown, Message, Message> }) {
        roots.delete(this.ctx);
      },
    });

  Object.defineProperty(rootTrackerPlugin, "name", { value: "rootTracker" });

  return {
    plugin: rootTrackerPlugin,
    async stopAll() {
      for (const root of roots) {
        try {
          root.sendSelf({ type: "STOP" });
        } catch {}
      }
      roots.clear();
    },
  };
}
