import type { ActorPlugin } from "../hooks";
import { mergeConfigs } from "../hooks";
import type { Message, SenderInfo } from "../types";

declare module "../index" {
  interface ActorDecorated {
    log: Logger;
  }
}

export interface DebugLogFn {
  (message: string, ...args: unknown[]): void;
}
/**
 * Optional context for a logged message.  The plugin fills both fields for the
 * traffic it observes; a caller logging a message by hand may omit them.
 */
export interface MessageLogOpts {
  /** Who sent it.  Present for traffic observed by the plugin. */
  sender?: SenderInfo;
  /** Direction: "in" = received by this actor, "out" = emitted by it. */
  direction?: "in" | "out";
}
export interface MessageLogFn {
  (message: Message, opts?: MessageLogOpts): void;
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
    msg: (msg: Message, opts?: MessageLogOpts) =>
      console.debug(`[${name}] ${opts?.direction === "out" ? "→" : "←"} ${msg.type}`, msg),
    info: (...a: unknown[]) => console.info(`[${name}]`, ...a),
    warn: (...a: unknown[]) => console.warn(`[${name}]`, ...a),
    error: (...a: unknown[]) => console.error(`[${name}]`, ...a),
    lifecycle: (event: string, detail?: unknown) =>
      console.debug(`[${name}] lifecycle ${event}`, detail ?? ""),
  };
}

/**
 * A logger that is constructed on first use, and rebuilt if the name it is
 * bound to changes.
 *
 * The plugin cannot build its logger eagerly: `config.name` is only a
 * *preferred* name — most actors leave it unset and get their process name
 * assigned by the framework — so binding a logger to it at plugin time files
 * every entry under the fallback name.  Deferring construction until the actor
 * has actually started means the factory always receives the resolved name.
 */
function deferredLogger(factory: LoggerFactory, getName: () => string): Logger {
  let inner: Logger | null = null;
  let boundTo: string | null = null;

  const resolve = (): Logger => {
    const name = getName();
    if (!inner || boundTo !== name) {
      inner = factory(name);
      boundTo = name;
    }
    return inner;
  };

  return {
    debug: (msg: string, ...args: unknown[]) => resolve().debug(msg, ...args),
    info: (msg: string, ...args: unknown[]) => resolve().info(msg, ...args),
    warn: (msg: string, ...args: unknown[]) => resolve().warn(msg, ...args),
    error: (msg: string, ...args: unknown[]) => resolve().error(msg, ...args),
    msg: (msg: Message, opts?: MessageLogOpts) => resolve().msg(msg, opts),
    lifecycle: (event: string, detail?: unknown) => resolve().lifecycle(event, detail),
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
    // Preferred name as a placeholder; replaced with the resolved process name
    // in `beforeStart`, before anything is logged.
    let name: string = config.name ?? "actor";
    const log = deferredLogger(factory, () => name);

    let result = mergeConfigs(config, {
      methods: { ...config.methods },
      $decorate: { log },
    });

    result = mergeConfigs(result, {
      beforeStart() {
        name = this.name;
      },
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
      onMessage(msg: Message, sender: SenderInfo) {
        if (ignoreSet.has(msg.type)) return;
        const m = msgFilter ? msgFilter(msg) : msg;
        if (m) log.msg(m, { sender, direction: "in" });
      },
      onEmit(msg: Message, sender: SenderInfo) {
        if (ignoreSet.has(msg.type)) return;
        const m = msgFilter ? msgFilter(msg) : msg;
        if (m) log.msg(m, { sender, direction: "out" });
      },
    });

    return result;
  };
}
