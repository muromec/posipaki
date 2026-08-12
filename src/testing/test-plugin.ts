// ── Test Plugins ─────────────────────────────────────────────────────────
//
// createCollector: per-actor message collector plugin.
// createRootTracker: global process tracker for cleanup.

import { mergeConfigs, type ActorPlugin } from "../hooks.js";
import type { Message, ProcessCtx } from "../types.js";

// ── types ────────────────────────────────────────────────────────────────

export interface MatchSpec {
  [key: string]: unknown;
}

export interface Collector<M extends Message> {
  plugin: ActorPlugin;
  messages: M[];
  resolved(): Promise<{ ok: boolean; detail?: string }>;
  next(
    filter: MatchSpec | MatchSpec[],
    opts?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; detail?: string }>;
  reset(newFilter?: MatchSpec | MatchSpec[]): void;
}

export interface RootTracker {
  plugin: ActorPlugin;
  stopAll(): Promise<void>;
}

// ── shallow match ────────────────────────────────────────────────────────

function shallowMatch(msg: Record<string, unknown>, spec: MatchSpec): boolean {
  for (const key of Object.keys(spec)) {
    if (msg[key] !== spec[key]) return false;
  }
  return true;
}

// ── createCollector ──────────────────────────────────────────────────────

export function createCollector<M extends Message>(
  filter: MatchSpec | MatchSpec[],
  opts?: { timeoutMs?: number; scope?: string | RegExp },
): Collector<M> {
  const specs: MatchSpec[] = Array.isArray(filter) ? filter : [filter];
  const messages: M[] = [];
  const scope = opts?.scope;

  let resolvePending: ((result: { ok: boolean; detail?: string }) => void) | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  function checkMatch(): boolean {
    return specs.every((s) => messages.some((m) => shallowMatch(m as Record<string, unknown>, s)));
  }

  function settle(ok: boolean, detail?: string) {
    if (timeout) { clearTimeout(timeout); timeout = null; }
    if (resolvePending) {
      resolvePending({ ok, detail });
      resolvePending = null;
    }
  }

  function waitForMatch(ms?: number): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      // Already matched?
      if (checkMatch()) {
        resolve({ ok: true });
        return;
      }
      resolvePending = resolve;
      if (ms && ms > 0) {
        timeout = setTimeout(() => settle(false, `Timeout: expected matches not seen within ${ms}ms`), ms);
      }
    });
  }

  function collectorPlugin(this: any, cfg: any) {
    return mergeConfigs(cfg, {
      afterStart(this: any) {
        // Capture root actor name for scope filtering
        (cfg as any).pvtRootName = this.name;
      },
      onEmit(this: any, msg: M) {
        // Scope filtering
        if (scope !== undefined && scope !== "*") {
          const rootName = (cfg as any).pvtRootName;
          if (typeof scope === "string") {
            if (this.name !== scope && this.name !== rootName) return;
          } else if (scope instanceof RegExp) {
            if (!scope.test(this.name)) return;
          }
        } else if (scope === undefined) {
          // Default: root actor only
          const rootName = (cfg as any).pvtRootName;
          if (this.name !== rootName) return;
        }

        messages.push(msg as M);
        if (checkMatch()) {
          settle(true);
        }
      },
      onEnd() {
        if (resolvePending) {
          settle(false, "Actor exited before matches");
        }
      },
    });
  }

  // Ensure the plugin has a name for dedup
  Object.defineProperty(collectorPlugin, "name", { value: "messageCollector" });

  return {
    plugin: collectorPlugin,
    messages,
    resolved: () => waitForMatch(opts?.timeoutMs ?? 5000),
    next(nextFilter: MatchSpec | MatchSpec[], nextOpts?: { timeoutMs?: number }) {
      // Update specs and re-check
      (specs as MatchSpec[]).length = 0;
      const nextSpecs = Array.isArray(nextFilter) ? nextFilter : [nextFilter];
      specs.splice(0, specs.length, ...nextSpecs);
      return waitForMatch(nextOpts?.timeoutMs ?? 5000);
    },
    reset(newFilter?: MatchSpec | MatchSpec[]) {
      settle(false, "reset");
      if (newFilter) {
        (specs as MatchSpec[]).length = 0;
        const newSpecs = Array.isArray(newFilter) ? newFilter : [newFilter];
        specs.push(...newSpecs);
      }
    },
  };
}

// ── createRootTracker ────────────────────────────────────────────────────

export function createRootTracker(): RootTracker {
  const roots = new Set<ProcessCtx<any, any, any, any>>();

  function rootTrackerPlugin(cfg: any) {
    return mergeConfigs(cfg, {
      afterStart(this: any) {
        roots.add(this.ctx);
      },
      onEnd(this: any) {
        roots.delete(this.ctx);
      },
    });
  }

  Object.defineProperty(rootTrackerPlugin, "name", { value: "rootTracker" });

  return {
    plugin: rootTrackerPlugin,
    async stopAll() {
      for (const ctx of roots) {
        try { ctx.sendSelf({ type: "STOP" } as any); } catch {}
      }
      roots.clear();
    },
  };
}
