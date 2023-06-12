function defer(fn) {
  (window.setImmediate || requestIdleCallback)(fn);
}

function spawn(fn, pname, toParent = ()=> null) {
  let current = null;
  let buffer = [];
  let resolveExit;
  let children = [];
  let exitPromise = new Promise(resolve => {
    resolveExit = resolve;
  });

  function send ({ to = pparent, ...msg }) {
    tick(to.next({ msg }));
  }

  function tick (ret) {
    let msg;
    while(msg = buffer.pop()) {
      toSelf({pname, ...msg});
    }
    if (ret && ret.done) {
      resolveExit();
    }
  }
  function toSelf(msg) {
    send({ to: current, ...msg});
  }
  function toBuffer(msg) {
    buffer.push(msg);
    defer(tick);
  }
  function fromChild(msg) {
    if (msg.type === 'EXIT') {
      children = children.filter(p=> p !== msg.pid);
    }
    toBuffer(msg);
  }
  function toAllChildren(msg) {
    children.forEach(p => p.send(msg));
  }

  function fork (fn, pname) {
    return (...args) => {
      const child =  spawn(fn, pname, fromChild)(...args);
      children.push(child);
      return child;
    }
  }
  function wait () {
    return exitPromise;
  }
  return (...args) => {
    const process = {
      pname,
      send: toBuffer,
      fork,
      toParent,
      toAllChildren,
      id: Symbol(pname),
      state: null,
      wait,
    };
    const task = watchExit(fn)(process, ...args);
    current = task;
    let ret = task.next();
    process.state = ret.value;
    tick(task.next());

    return process;
  }
}

function watchExit(fn) {
  return function* (process, ...args) {
    yield* fn(process, ...args);
    process.toAllChildren({ type: 'STOP' });
    process.toParent({ type: 'EXIT', pid: process.id});
  }
}

function debugLog(level, ...args) {
  if (level) {
    console.log(...args);
  }
}

function* runDispatch(name, fn, readyFn = ()=> false, debugLevel = false) {
  let msg;
  while(!readyFn()) {
    ({msg} = yield);
    debugLog(debugLevel, 'msg', name, ' <- ', msg);
    fn(msg);
  }
}
export { spawn, runDispatch };
