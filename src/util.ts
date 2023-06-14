import type Process from './process';
import type { ProcessCtx, Message } from './process';

function debugLog(level: boolean, ...args: Array<unknown>) {
  if (level) {
    console.log(...args);
  }
}

type ReducerClosure<M> = (msg: M) => void;
type ReadyFn = () => boolean;
type NotifyFn = () => void;

function* runDispatch<M>(name: string, fn : ReducerClosure<M>, readyFn: ReadyFn = ()=> false, debugLevel = false) : Generator<null, void, M> {
  let msg: M;
  while(!readyFn()) {
    msg = yield null;
    debugLog(debugLevel, 'msg', name, ' <- ', msg);
    fn(msg);
  }
}

export type ExitMessage = {
  type: 'EXIT';
  pid: Symbol;
};

function watchExit<Args, State, InMessage extends Message, OutMessage extends (Message | ExitMessage)>(process: Process<Args, State, InMessage, OutMessage>) {
  return function* (ctx: ProcessCtx<InMessage, OutMessage>, arg0: Args) {
    yield* process.pgenerator(ctx, arg0);
    process.toAllChildren({ type: 'STOP' });
    process.toParent({ type: 'EXIT', pid: process.id} as OutMessage);
  }
}

type DeferCb = () => void;
type Defer = (fn: DeferCb) => void;
type WindowGlobal = {
  setImmediate?: Defer
};

function defer(fn: DeferCb) {
  const g = globalThis as WindowGlobal;
  const setDefer = (g.setImmediate || requestIdleCallback) as Defer;
  setDefer(fn);
}
export type Waiter = {
  promise: Promise<void>;
  resolve: NotifyFn;
};
function makeWaiter() : Waiter {
  let resolve: unknown;
  let promise = new Promise<void>(_resolve => {
    resolve = _resolve;
  });
  return {promise, resolve: resolve as NotifyFn};
}

export { runDispatch, watchExit, defer, makeWaiter };
