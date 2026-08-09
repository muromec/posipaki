// ── debugLogger Plugin ───────────────────────────────────────────────────
//
// Controlled via the DEBUG environment variable.
//
// DEBUG format: comma-separated patterns with glob-like subtree matching.
//
//   DEBUG=*                           enable all debug logging
//   DEBUG=openai:connector            log only the connector actor
//   DEBUG=openai:*                    log the openai actor and its subtree
//   DEBUG=openai:connector,openai:tools  log connector and tools
//
// Usage:
//
//   import { debugLogger } from 'posipaki/plugins/debug-logger';
//   const MyActor = defineActor({
//     plugins: [debugLogger()],
//     ...
//   });
//
// The plugin decorates every actor with `this.log` — a logger instance
// available in handlers, hooks, and lifecycle methods.  By default it
// writes to `console`, but you can supply a custom factory:
//
//   import { debugLogger } from 'posipaki/plugins/debug-logger';
//   plugins: [debugLogger({ factory: (name) => myCustomLogger(name) })],
//
// Message filtering: pass `ignore` to suppress noisy message types.
//
//   plugins: [debugLogger({ ignore: ['HEARTBEAT', 'TICK'] })],
//

import type { ActorPlugin } from '../hooks.js';

// ── Logger interface ────────────────────────────────────────────────────

export interface DebugLogFn {
  (message: string, ...args: unknown[]): void;
}

export interface Logger {
  debug: DebugLogFn;
  info: DebugLogFn;
  warn: DebugLogFn;
  error: DebugLogFn;
}

/** Factory: receives an actor name, returns a Logger. */
export type LoggerFactory = (name: string) => Logger;

// ── options ─────────────────────────────────────────────────────────────

export interface DebugLoggerOpts {
  /** Message types to silence (e.g. ['HEARTBEAT', 'TICK']).  Default: none. */
  ignore?: string[];
  /** Logger factory.  Default: console-based logger. */
  factory?: LoggerFactory;
}

// ── pattern matching ─────────────────────────────────────────────────────

function patterns(): string[] {
  const raw = (process.env.DEBUG ?? '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

function matches(name: string, pats: string[]): boolean {
  if (pats.length === 0) return false;
  for (const p of pats) {
    if (p === '*') return true;
    if (p.endsWith(':*')) {
      const prefix = p.slice(0, -2);
      if (name === prefix || name.startsWith(prefix + ':')) return true;
      continue;
    }
    if (p === name) return true;
  }
  return false;
}

// ── default logger ──────────────────────────────────────────────────────

function defaultFactory(name: string): Logger {
  return {
    debug: (...args: unknown[]) => console.debug(`[${name}]`, ...args),
    info: (...args: unknown[]) => console.info(`[${name}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${name}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${name}]`, ...args),
  };
}

// ── plugin ───────────────────────────────────────────────────────────────

export function debugLogger(opts?: DebugLoggerOpts): ActorPlugin {
  const ignoreSet = new Set(opts?.ignore ?? []);
  const factory = opts?.factory ?? defaultFactory;

  return {
    name: 'debugLogger',
    install(self) {
      const name: string = self.name;
      const pats = patterns();
      const log = factory(name);

      // Always decorate so handlers can use this.log.
      self.decorate('log', log);

      // Only register hooks if DEBUG patterns match.
      if (!matches(name, pats)) return;

      self.hooks.onMessage((msg: any, sender: any) => {
        if (ignoreSet.has(msg.type)) return;
        const via = sender?.fromName ? ` from ${sender.fromName}` : '';
        log.debug(`${name} ← ${msg.type}${via}`, msg);
      });

      self.hooks.onEmit((msg: any) => {
        log.debug(`${name} → ${msg.type}`, msg);
      });

      self.hooks.onChildExit((childName: string) => {
        log.debug(`child ${childName} exited`);
      });

      self.hooks.onError((err: unknown) => {
        log.error(`${(err as Error).message ?? err}`);
      });
    },
  };
}
