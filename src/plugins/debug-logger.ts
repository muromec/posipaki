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
/** How far the filter looks, and how many values it will visit. */
const MAX_DEPTH = 4;
const MAX_VALUES = 200;

/** An object whose values are its fields, and not an instance of something. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Bytes: a typed array, a data view, an ArrayBuffer, or a Buffer — which is a Uint8Array. */
function isBinary(value: object): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/** A size a person reads: `6.8 MB`, `291.0 kB`, `512 B`. */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${bytes} B`;
}

/** What a binary field says in a log: what it is and how big, never what it holds. */
function binarySummary(value: ArrayBuffer | ArrayBufferView): string {
  const name = value instanceof ArrayBuffer ? "ArrayBuffer" : (value.constructor?.name ?? "Uint8Array");
  return `<${name} ${humanBytes(value.byteLength)}>`;
}

/**
 * Shrink one value, answering with the value itself when nothing inside it changed —
 * the filter's contract is to hand back the very message it was given unless a field
 * had to go.
 *
 * Bytes are why this walks at all: `JSON.stringify` renders a megabyte of typed array
 * as six megabytes of numbers, so an attachment riding on a message turned a log line
 * into half a minute of CPU.  The copy is shallow where nothing changed and deep where
 * something did.
 */
function shrinkValue(
  value: unknown,
  seen: WeakSet<object>,
  budget: { left: number },
  depth: number,
): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (isBinary(value)) return binarySummary(value);
  if (depth > MAX_DEPTH || budget.left <= 0) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY) return `[${value.length} items]`;
      let changed = false;
      const items = value.map((item) => {
        budget.left -= 1;
        const next = shrinkValue(item, seen, budget, depth + 1);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? items : value;
    }
    if (!isPlainObject(value)) return value;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      budget.left -= 1;
      const next = shrinkValue(item, seen, budget, depth + 1);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  } finally {
    seen.delete(value);
  }
}

/**
 * Default message filter: shrink oversized fields so one message (a full conversation
 * history, a big tool result, an attachment) cannot flood the log.  Long strings are
 * cut, long arrays are counted, and bytes become a summary — what they are and how
 * big, never what they hold.  Returns the message unchanged when nothing needed
 * shrinking.
 */
export function defaultMsgFilter(msg: Message): Message {
  const shrunk = shrinkValue(msg, new WeakSet(), { left: MAX_VALUES }, 0);
  return shrunk === msg ? msg : (shrunk as Message);
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
