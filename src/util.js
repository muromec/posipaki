function debugLog(level, ...args) {
  if (level) {
    console.log(...args);
  }
}

function* runDispatch(name, fn, readyFn = ()=> false, debugLevel = false) {
  let msg;
  while(!readyFn()) {
    msg = yield;
    debugLog(debugLevel, 'msg', name, ' <- ', msg);
    fn(msg);
  }
}

function watchExit(process) {
  return function* (ctx, ...args) {
    yield* process.pgenerator(ctx, ...args);
    process.toAllChildren({ type: 'STOP' });
    process.toParent({ type: 'EXIT', pid: process.id});
  }
}
function defer(fn) {
  (globalThis.setImmediate || requestIdleCallback)(fn);
}

function makeWaiter() {
  let resolve;
  let promise = new Promise(_resolve => {
    resolve = _resolve;
  });
  return {promise, resolve};
}

export { runDispatch, watchExit, defer, makeWaiter };
