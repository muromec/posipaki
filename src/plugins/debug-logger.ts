// ── debugLogger Plugin ───────────────────────────────────────────────────
//
// Example plugin: logs every message entering and leaving the actor.
//
// Usage:
//   import { debugLogger } from 'posipaki/plugins/debug-logger';
//   const MyActor = defineActor({ plugins: [debugLogger()], ... });

import type { ActorPlugin } from '../hooks.js';

export interface DebugLoggerOpts {
  level?: 'debug' | 'info';
  skipHeartbeats?: boolean;
}

export function debugLogger(opts?: DebugLoggerOpts): ActorPlugin {
  const level = opts?.level ?? 'debug';
  const skipHbs = opts?.skipHeartbeats ?? true;

  return {
    name: 'debugLogger',
    install(ctx: any) {
      const name = ctx.pname;

      ctx.onMessage?.((msg: any, sender: any) => {
        if (skipHbs && msg.type === 'HEARTBEAT') return;
        const via = sender ? ` from ${sender.fromName}` : '';
        log(level, `${name} ← ${msg.type}${via}`);
      });

      ctx.onEmit?.((msg: any) => {
        log(level, `${name} → ${msg.type}`);
      });

      ctx.onChildExit?.((childName: string) => {
        log(level, `${name}: child ${childName} exited`);
      });

      ctx.onError?.((err: unknown) => {
        console.error(`[${name}] error:`, (err as Error).message ?? err);
      });
    },
  };
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${msg}`;
  if (level === 'info') console.info(line);
  else console.debug(line);
}
