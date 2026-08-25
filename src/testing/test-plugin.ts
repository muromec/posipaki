// ── Test Plugins ─────────────────────────────────────────────────────────
//
// createCollector: per-actor message collector plugin.
// createRootTracker: global process tracker for cleanup.
//
// Observation model: the collector is a plugin installed on the root.  It
// sees every message that flows through the process's onEmit, filtered by
// a pname scope (default: the root and everything below it).  Waiting is
// event-driven — `resolved()` settles when a matching message arrives, the
// actor exits, or an explicit timeout fires.  No polling.

import { mergeConfigs, type ActorPlugin, type ActorReflection } from "../hooks.js";
import type { ActorContext, ReflectionOptions } from "../actor-types.js";

import type { Message, SenderInfo } from "../types.js";
import { toMatcher, type MatchSpec } from "./msg-matcher.js";
import { pnameMatch } from "./pname-match.js";
import { withTimeout, makeWaiter, type Waiter } from "../util.js";

const DEFAULT_TIMEOUT = 4500;

// ── types ────────────────────────────────────────────────────────────────

export interface MatchResult {
  ok: boolean;
  /** Human-readable diagnosis on failure (timeout / exit-before-match). */
  detail?: string;
}

export interface Collector<M extends Message> {
  plugin: ActorPlugin;
  messages: M[];
  /**
   * Wait until the collected history matches the current filter,
   * the actor exits or timeout deadline hits.
   *
   * @param timeoutMs - deadline, defaults to 4.5 seconds
   *
   */
  resolved(timeoutMs?: number): Promise<MatchResult>;
  next(filter: MatchSpec<M>, timeoutMs?: number): Promise<MatchResult>;
  reset(filter?: MatchSpec<M>): void;
}

export interface RootTracker {
  plugin: ActorPlugin;
  stopAll(): Promise<void>;
}

// ── diagnostics helpers ──────────────────────────────────────────────────

function describeSpec<M extends Message>(spec: MatchSpec<M>): string {
  if (typeof spec === "function") return "predicate";
  if (Array.isArray(spec)) return `sequence [${spec.map((s) => JSON.stringify(s)).join(" → ")}]`;
  return JSON.stringify(spec);
}

function lastSummary<M extends Message>(messages: M[]): string {
  const last = messages[messages.length - 1];
  if (last === undefined) return "none";
  return JSON.stringify(last).slice(0, 120);
}

// ── createCollector ──────────────────────────────────────────────────────

export function createCollector<M extends Message>(
  filter: MatchSpec<M>,
  opts?: { scope?: string | string[] },
): Collector<M> {
  const messages: M[] = [];
  let matcher = toMatcher(filter);
  // The spec currently active — kept in sync with `matcher` so timeout
  // diagnostics can say what was expected.
  let currentSpec: MatchSpec<M> = filter;
  // Captured from the root's beforeStart; used as the default scope.
  let defaultScope: string[] = [];
  // The plugin is installed on the root first (spawn assembles before any
  // child is forked), so the first install's beforeStart is the root.
  let installed = false;
  let waiters: Waiter<MatchResult>[] = [];

  function setSpec(spec: MatchSpec<M>) {
    currentSpec = spec;
    matcher = toMatcher(spec);
  }

  function scopePatterns(): string[] {
    if (opts?.scope === undefined) return defaultScope;
    return Array.isArray(opts.scope) ? opts.scope : [opts.scope];
  }

  function checkAndNotify() {
    const last = messages[messages.length - 1];
    if (last !== undefined && matcher(last, messages)) {
      const ws = waiters.splice(0);
      for (const w of ws) w.resolve({ ok: true });
    }
  }

  async function resolved(timeoutMs: number = DEFAULT_TIMEOUT): Promise<MatchResult> {
    const last = messages[messages.length - 1];
    if (last !== undefined && matcher(last, messages)) {
      return { ok: true };
    }
    const matchWaiter = makeWaiter<MatchResult>();
    waiters.push(matchWaiter);

    try {
      return await withTimeout(matchWaiter.promise, timeoutMs, "test-match");
    } catch (e) {
      if ((e as Error)?.message !== "Timeout:test-match") {
        throw e;
      }

      return {
        ok: false,
        detail:
          `timeout after ${timeoutMs}ms — expected: ${describeSpec(currentSpec)} ` +
          `— received ${messages.length} message(s), last: ${lastSummary(messages)}`,
      };
    }
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
      beforeEnd() {
        const ws = waiters.splice(0);
        for (const w of ws) w.resolve({ ok: false, detail: "actor exited before match" });
      },
    });
  };

  // Named function so framework deduplication works.
  Object.defineProperty(collectorPlugin, "name", { value: "messageCollector" });

  return {
    plugin: collectorPlugin,
    messages,
    resolved,
    next(nextFilter, timeoutMs = DEFAULT_TIMEOUT) {
      setSpec(nextFilter);
      return resolved(timeoutMs);
    },
    reset(newFilter) {
      if (newFilter) setSpec(newFilter);
    },
  };
}

// ── createRootTracker ────────────────────────────────────────────────────

export function createRootTracker(): RootTracker {
  const roots = new Set<
    ActorContext<unknown, unknown, Message, Message, {}, {}, ReflectionOptions & ActorReflection>
  >();

  const rootTrackerPlugin: ActorPlugin = (config) =>
    mergeConfigs(config, {
      beforeStart() {
        roots.add(this);
      },
      afterEnd() {
        roots.delete(this);
      },
    });

  Object.defineProperty(rootTrackerPlugin, "name", { value: "rootTracker" });

  return {
    plugin: rootTrackerPlugin,
    async stopAll() {
      for (const root of roots) {
        try {
          root.exit();
        } catch {}
      }
      roots.clear();
    },
  };
}
