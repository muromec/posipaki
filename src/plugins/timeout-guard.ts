// ── timeoutGuard Plugin ──────────────────────────────────────────────────
//
// Kills the actor if no message is received within `ms` milliseconds.
//
// Usage:
//   import { timeoutGuard } from 'posipaki/plugins/timeout-guard';
//   const MyActor = defineActor({ plugins: [timeoutGuard({ ms: 30_000 })], ... });

import type { ActorPlugin } from '../hooks.js';

export interface TimeoutGuardOpts {
  ms: number;
}

export function timeoutGuard(opts: TimeoutGuardOpts): ActorPlugin {
  return {
    name: 'timeoutGuard',
    install(self: any) {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const reset = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          console.error(`[${self.name}] timeout after ${opts.ms}ms — exiting`);
          try { process.exit(1); } catch {}
        }, opts.ms);
      };

      self.hooks.onMessage(() => reset());
      self.hooks.onStart(() => reset());
    },
  };
}
