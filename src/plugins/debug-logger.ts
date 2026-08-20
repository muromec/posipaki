import type { ActorPlugin } from "../hooks";
import { mergeConfigs } from "../hooks";
import type { Message } from "../types";

declare module "../index" {
  interface ActorDecorated {
    log: Logger;
  }
}

export interface DebugLogFn {
  (message: string, ...args: unknown[]): void;
}
export interface MessageLogFn {
  (message: Message): void;
}
export interface LifecycleLogFn {
  (event: string, detail?: unknown): void;
}

export interface Logger {
  debug: DebugLogFn;
  info: DebugLogFn;
  warn: DebugLogFn;
  error: DebugLogFn;
  msg: MessageLogFn;
  lifecycle: LifecycleLogFn;
}
export type LoggerFactory = (name: string) => Logger;

/**
 * Filter a message before it is logged.  Return a (possibly shrunk) message,
 * or `null` to skip it entirely.  Used to keep large payloads — a full
 * conversation history, a big tool result — out of the log scroll.
 */
export type MsgFilter = (msg: Message) => Message | null;

export interface DebugLoggerOpts {
  /** Message types to skip entirely (in addition to any `msgFilter`). */
  ignore?: string[];
  factory?: LoggerFactory;
  /** Shrink or skip a message before it is logged via onMessage/onEmit.
   *  Defaults to {@link defaultMsgFilter}. */
  msgFilter?: MsgFilter;
}

/** Fields larger than this are shrunk by {@link defaultMsgFilter}. */
const MAX_STRING = 256;
const MAX_ARRAY = 16;

/**
 * Default message filter: shrink oversized string/array fields in place so a
 * single message (a full conversation history, a big tool result) can't flood
 * the log.  Returns the message unchanged when nothing needs shrinking.
 */
export function defaultMsgFilter(msg: Message): Message {
  const src = msg as unknown as Record<string, unknown>;
  const shrunk: Record<string, unknown> = { ...src };
  let changed = false;
  for (const key of Object.keys(src)) {
    const v = src[key];
    if (typeof v === "string" && v.length > MAX_STRING) {
      shrunk[key] = `${v.slice(0, MAX_STRING)}… (${v.length} chars)`;
      changed = true;
    } else if (Array.isArray(v) && v.length > MAX_ARRAY) {
      shrunk[key] = `[${v.length} items]`;
      changed = true;
    }
  }
  return changed ? (shrunk as unknown as Message) : msg;
}

function defaultFactory(name: string): Logger {
  return {
    debug: (...a: unknown[]) => console.debug(`[${name}]`, ...a),
    msg: (msg: Message) => console.debug(`[${name}] ←`, msg),
    info: (...a: unknown[]) => console.info(`[${name}]`, ...a),
    warn: (...a: unknown[]) => console.warn(`[${name}]`, ...a),
    error: (...a: unknown[]) => console.error(`[${name}]`, ...a),
    lifecycle: (event: string, detail?: unknown) =>
      console.debug(`[${name}] lifecycle ${event}`, detail ?? ""),
  };
}

/**
 * A debug/logging plugin that decorates `this.log` and observes the actor
 * lifecycle (started / stopping / stopped / child-exited / error) plus message
 * traffic.  Hook registration is no longer gated by `DEBUG` — the supplied
 * factory decides what to actually emit, so a ringbuffer (or anything else)
 * can gate output at runtime.
 */
export function debugLogger(opts?: DebugLoggerOpts): ActorPlugin {
  const ignoreSet = new Set(opts?.ignore ?? []);
  const factory = opts?.factory ?? defaultFactory;
  const msgFilter = opts?.msgFilter ?? defaultMsgFilter;
  return async function debugLoggerPlugin(config) {
    const name: string = config.name ?? "actor";
    const log = factory(name);

    let result = mergeConfigs(config, {
      methods: { ...config.methods },
      $decorate: { log },
    });

    result = mergeConfigs(result, {
      afterStart() {
        log.lifecycle("started");
      },
      beforeEnd(reason: unknown) {
        log.lifecycle("stopping", reason);
      },
      afterEnd(reason: unknown) {
        log.lifecycle("stopped", reason);
      },
      onChildExit(childName: string) {
        log.lifecycle("child-exited", childName);
      },
      onError(err: unknown) {
        log.error(`${(err as Error)?.message ?? err}`);
      },
      onMessage(msg: Message) {
        if (ignoreSet.has(msg.type)) return;
        const m = msgFilter ? msgFilter(msg) : msg;
        if (m) log.msg(m);
      },
      onEmit(msg: Message) {
        if (ignoreSet.has(msg.type)) return;
        const m = msgFilter ? msgFilter(msg) : msg;
        if (m) log.debug(`${name} → ${m.type}`, m);
      },
    });

    return result;
  };
}
