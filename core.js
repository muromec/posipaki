import Process, { spawn } from './process.js';

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
export { spawn, runDispatch };
