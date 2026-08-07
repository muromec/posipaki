import type { ExitMessage } from "./types.js";
export declare function debugLog(level: boolean, ...args: Array<unknown>): void;
type ReducerClosure<M> = (msg: M) => void;
type ReadyFn = () => boolean;
type NotifyFn = () => void;
/**
 * Generator helper that loops, yielding `null` and feeding incoming
 * messages to `fn` until `readyFn()` returns true. Used inside
 * process generators to build the main message loop.
 */
declare function runDispatch<M>(name: string, fn: ReducerClosure<M>, readyFn?: ReadyFn, debugLevel?: boolean): Generator<null, void, M>;
/**
* @deprecated Use AsyncProcess._watchExit instead.
 *
 * Wrap a process generator so that on completion it sends STOP to
 * all children and EXIT to the parent. Useful for custom process
 * wrappers that need lifecycle management without extending
 * AsyncProcess.
 */
declare function watchExit<A, S, IM extends {
    type: string;
}, OM extends {
    type: string;
} | ExitMessage>(proc: {
    toAllChildren: (m: {
        type: string;
    }) => void;
    toParent: (m: OM) => void;
    id: symbol;
    pname: string;
}, gen: (ctx: any, args: A) => Generator<S | null, void, IM>): (ctx: any, args: A) => Generator<S | null, void, IM>;
type DeferCb = () => void;
/** Handle to a scheduled (but not yet executed) callback. */
export type DeferredCall = {
    cancel: () => void;
    flush: () => void;
};
/** Schedule a function to run on the next microtask. Returns an
 * object with `cancel()` and `flush()` methods. */
declare function defer(fn: DeferCb): DeferredCall;
/** A promise paired with its resolve function — used to signal
 * process completion. */
export type Waiter = {
    promise: Promise<void>;
    resolve: NotifyFn;
};
/** Create a new {@link Waiter}. */
declare function makeWaiter(): Waiter;
export { runDispatch, defer, makeWaiter, watchExit };
export type { ExitMessage };
//# sourceMappingURL=util.d.ts.map