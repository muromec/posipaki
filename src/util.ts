import type { ExitMessage } from "./types.js";
export function debugLog(level: boolean, ...args: Array<unknown>) {
  if (level) {
    console.log(...args);
  }
}

type ReducerClosure<M> = (msg: M) => void;
type ReadyFn = () => boolean;
type NotifyFn<T = void> = (v: T) => void;
type ErrorFn = (e: Error | null) => void;

/**
 * Generator helper that loops, yielding `null` and feeding incoming
 * messages to `fn` until `readyFn()` returns true. Used inside
 * process generators to build the main message loop.
 */
function* runDispatch<M>(
  name: string,
  fn: ReducerClosure<M>,
  readyFn: ReadyFn = () => false,
  debugLevel = false,
): Generator<null, void, M> {
  let msg: M;
  while (!readyFn()) {
    msg = yield null;
    debugLog(debugLevel, "msg", name, " <- ", msg);
    fn(msg);
  }
}

type DeferCb = () => void;
type Defer = (fn: DeferCb) => unknown;
type Cancel = (taskId: any) => void;
type WindowGlobal = {
  setImmediate?: Defer;
  clearImmediate?: Cancel;
  requestIdleCallback?: Defer;
  cancelIdleCallback?: Cancel;
  setTimeout: Defer;
  clearTimeout: Cancel;
};

/** Handle to a scheduled (but not yet executed) callback. */
export type DeferredCall = {
  cancel: () => void;
  flush: () => void;
};
/** Schedule a function to run on the next microtask. Returns an
 * object with `cancel()` and `flush()` methods. */
function defer(fn: DeferCb): DeferredCall {
  const g = globalThis as WindowGlobal;
  function schedule(deferFn: Defer, cancelFn: Cancel) {
    const taskId = deferFn(fn);
    return () => cancelFn(taskId);
  }
  let cancel: () => void;
  if (g.setImmediate && g.clearImmediate) {
    cancel = schedule(g.setImmediate, g.clearImmediate);
  } else if (g.requestIdleCallback && g.cancelIdleCallback) {
    cancel = schedule(g.requestIdleCallback, g.cancelIdleCallback);
  } else {
    cancel = schedule((f) => setTimeout(f, 0), clearTimeout);
  }

  function flush() {
    cancel();
    fn();
  }

  return { flush, cancel };
}
/** A promise paired with its resolve function — used to signal
 * process completion. */
export type Waiter<T = void> = {
  promise: Promise<T>;
  resolve: NotifyFn<T>;
  reject: ErrorFn;
};
/** Create a new {@link Waiter}. */
function makeWaiter<T = void>(): Waiter<T> {
  let resolve: NotifyFn<T>;
  let reject: ErrorFn;
  let promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TIMEOUT_SENTINEL = Symbol.for("__timeout__posipaki_internal");
export async function timeout(ms: number) {
  await sleep(ms);
  return TIMEOUT_SENTINEL;
}

export async function withTimeout<O>(promise: Promise<O>, ms: number, kind: string): Promise<O> {
  const result = await Promise.race([promise, timeout(ms)]);
  if (result === TIMEOUT_SENTINEL) {
    throw Error("Timeout:" + kind);
  }
  return result as O;
}

export { runDispatch, defer, makeWaiter };
export type { ExitMessage };
