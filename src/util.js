export function debugLog(level, ...args) {
    if (level) {
        console.log(...args);
    }
}
/**
 * Generator helper that loops, yielding `null` and feeding incoming
 * messages to `fn` until `readyFn()` returns true. Used inside
 * process generators to build the main message loop.
 */
function* runDispatch(name, fn, readyFn = () => false, debugLevel = false) {
    let msg;
    while (!readyFn()) {
        msg = yield null;
        debugLog(debugLevel, "msg", name, " <- ", msg);
        fn(msg);
    }
}
/**
* @deprecated Use AsyncProcess._watchExit instead.
 *
 * Wrap a process generator so that on completion it sends STOP to
 * all children and EXIT to the parent. Useful for custom process
 * wrappers that need lifecycle management without extending
 * AsyncProcess.
 */
function watchExit(proc, gen) {
    return function* (ctx, args) {
        try {
            yield* gen(ctx, args);
        }
        finally {
            proc.toAllChildren({ type: "STOP" });
            proc.toParent({
                type: "EXIT",
            });
        }
    };
}
/** Schedule a function to run on the next microtask. Returns an
 * object with `cancel()` and `flush()` methods. */
function defer(fn) {
    const g = globalThis;
    function schedule(deferFn, cancelFn) {
        const taskId = deferFn(fn);
        return () => cancelFn(taskId);
    }
    let cancel;
    if (g.setImmediate && g.clearImmediate) {
        cancel = schedule(g.setImmediate, g.clearImmediate);
    }
    else if (g.requestIdleCallback && g.cancelIdleCallback) {
        cancel = schedule(g.requestIdleCallback, g.cancelIdleCallback);
    }
    else {
        cancel = schedule((f) => setTimeout(f, 0), clearTimeout);
    }
    function flush() {
        cancel();
        fn();
    }
    return { flush, cancel };
}
/** Create a new {@link Waiter}. */
function makeWaiter() {
    let resolve;
    let promise = new Promise((_resolve) => {
        resolve = _resolve;
    });
    return { promise, resolve: resolve };
}
export { runDispatch, defer, makeWaiter, watchExit };
//# sourceMappingURL=util.js.map