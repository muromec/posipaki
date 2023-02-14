function spawn(fn, pname, toParent = ()=> null) {
  let current = null;
  let buffer = [];
  let resolveExit;
  let exitPromise = new Promise(resolve => {
    resolveExit = resolve;
  });

  function send ({ to = pparent, ...msg }) {
    let ret = to.next({ msg });
    tick();
    if (ret.done) {
      resolveExit();
    }
  }
  function tick () {
    let msg;
    while(msg = buffer.pop()) {
      toParent({pname, ...msg});
    }
  }
  function toSelf(msg) {
    send({ to: current, ...msg});
  }
  function fromChild(msg) {
    toSelf(msg);
  }
  function toBuffer(msg) {
    buffer.push(msg);
  }
  function fork (fn, pname) {
    return spawn(fn, pname, fromChild);
  }
  function wait () {
    return exitPromise;
  }
  return (...args) => {
    const process = {
      pname,
      send: toSelf,
      fork,
      toParent: toBuffer,
      id: Symbol(pname),
      state: null,
      wait,
    };
    const task = watchExit(fn)(process, ...args);
    current = task;
    let ret = task.next();
    process.state = ret.value;
    task.next();

    return process;
  }
}

function watchExit(fn) {
  return function* (process, ...args) {
    yield* fn(process, ...args);
    process.toParent({ type: 'EXIT', pid: process.id});
  }
}

function* runDispatch(name, fn, readyFn = ()=> false) {
  let msg;
  while(!readyFn()) {
    ({msg} = yield);
    console.log('msg', name, ' <- ', msg);
    fn(msg);
  }
}
export { spawn, runDispatch };
