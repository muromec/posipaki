// ── Test Plugins ─────────────────────────────────────────────────────────
//
// createCollector: per-actor message collector plugin.
// createRootTracker: global process tracker for cleanup.

import { mergeConfigs, type ActorPlugin } from "../hooks.js";
import type { Message, StopMessage, SenderInfo, ProcessCtx } from "../types.js";

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
  reset(filter?: MatchSpec | MatchSpec[]): void;
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

  let resolvePending: ((result: { ok: boolean; detail?: string }) => void) | null =
    null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  // The plugin is installed on the root actor first (spawn assembles before
  // any child is forked), so the first install is the root.  Scope filtering
  // is decided per-emitter at install time, not stashed on shared config.
  let installed = false;

  function checkMatch(): boolean {
    return specs.every((s) =>
      messages.some((m) => shallowMatch(m as Record<string, unknown>, s)),
    );
  }

  function settle(ok: boolean, detail?: string) {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (resolvePending) {
      resolvePending({ ok, detail });
      resolvePending = null;
    }
  }

  function waitForMatch(ms?: number): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      if (checkMatch()) {
        resolve({ ok: true });
        return;
      }
      resolvePending = resolve;
      if (ms && ms > 0) {
        timeout = setTimeout(
          () => settle(false, `Timeout: expected matches not seen within ${ms}ms`),
          ms,
        );
      }
    });
  }

  function inScope(emitter: string, isRoot: boolean): boolean {
    if (scope === undefined) return isRoot; // default: root actor only
    if (scope === "*") return true; // every emitter
    if (typeof scope === "string") return emitter === scope;
    return scope.test(emitter); // RegExp
  }

  const collectorPlugin: ActorPlugin = (config) => {
    const isRoot = !installed;
    installed = true;
    return mergeConfigs(config, {
      onEmit(msg: Message, sender: SenderInfo) {
        if (!inScope(sender.fromName, isRoot)) return;
        messages.push(msg as M);
        if (checkMatch()) settle(true);
      },
      onEnd() {
        if (resolvePending) settle(false, "Actor exited before matches");
      },
    });
  };

  // Named function so framework deduplication works.
  Object.defineProperty(collectorPlugin, "name", { value: "messageCollector" });

  return {
    plugin: collectorPlugin,
    messages,
    resolved: () => waitForMatch(opts?.timeoutMs ?? 5000),
    next(nextFilter, nextOpts) {
      specs.splice(
        0,
        specs.length,
        ...(Array.isArray(nextFilter) ? nextFilter : [nextFilter]),
      );
      return waitForMatch(nextOpts?.timeoutMs ?? 5000);
    },
    reset(newFilter) {
      settle(false, "reset");
      if (newFilter) {
        specs.splice(
          0,
          specs.length,
          ...(Array.isArray(newFilter) ? newFilter : [newFilter]),
        );
      }
    },
  };
}

// ── createRootTracker ────────────────────────────────────────────────────

type HasCtx = { ctx: ProcessCtx<unknown, unknown, Message, Message> };

export function createRootTracker(): RootTracker {
  const roots = new Set<{ sendSelf: (msg: StopMessage) => void }>();

  const rootTrackerPlugin: ActorPlugin = (config) =>
    mergeConfigs(config, {
      afterStart(this: HasCtx) {
        roots.add(this.ctx);
      },
      onEnd(this: HasCtx) {
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
