import type { ActorPlugin } from '../hooks.js';
import { mergeConfigs } from '../hooks.js';
import type { ActorConfig, HandlerOptions } from '../actor-types.js';
import type { Message } from '../types.js';

export interface DebugLogFn { (message: string, ...args: unknown[]): void; }
export interface Logger { debug: DebugLogFn; info: DebugLogFn; warn: DebugLogFn; error: DebugLogFn; }
export type LoggerFactory = (name: string) => Logger;
export interface DebugLoggerOpts { ignore?: string[]; factory?: LoggerFactory; }

function patterns(): string[] { const raw = (process.env.DEBUG ?? '').trim(); if (!raw) return []; return raw.split(',').map(p => p.trim()).filter(Boolean); }
function matches(name: string, pats: string[]): boolean {
  if (pats.length === 0) return false;
  for (const p of pats) { if (p === '*') return true; if (p.endsWith(':*')) { if (name === p.slice(0,-2) || name.startsWith(p.slice(0,-2)+':')) return true; } else if (p === name) return true; }
  return false;
}
function defaultFactory(name: string): Logger { return { debug: (...a: unknown[]) => console.debug(`[${name}]`,...a), info: (...a: unknown[]) => console.info(`[${name}]`,...a), warn: (...a: unknown[]) => console.warn(`[${name}]`,...a), error: (...a: unknown[]) => console.error(`[${name}]`,...a) }; }

export function debugLogger(opts?: DebugLoggerOpts): ActorPlugin {
  const ignoreSet = new Set(opts?.ignore ?? []);
  const factory = opts?.factory ?? defaultFactory;
  return async (config: ActorConfig<unknown, unknown, Message, Message, Message, {}, HandlerOptions<Message>>) => {
    const name: string = config.name ?? 'actor';
    const pats = patterns(); const log = factory(name);

    // Always decorate this.log — even when DEBUG is empty
    let result = mergeConfigs(config, {
      methods: { ...config.methods, log } as typeof config.methods,
    });

    if (matches(name, pats)) {
      result = mergeConfigs(result, {
        onMessage(msg: any) { if (!ignoreSet.has(msg.type)) log.debug(`${name} ← ${msg.type}`, msg); },
        onEmit(msg: any) { log.debug(`${name} → ${msg.type}`, msg); },
        onChildExit(childName: string) { log.debug(`child ${childName} exited`); },
        onError(err: unknown) { log.error(`${(err as Error).message ?? err}`); },
      });
    }

    return result;
  };
}
