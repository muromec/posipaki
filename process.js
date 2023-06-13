export function spawn(fn, pname, toParent) {
  return (...args) => {
    const process = new Process(fn, pname, toParent);
    process.start(args);
    return process;
  };
}
const noop = ()=> null;

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

export default class Process {
  constructor(fn, pname, toParent) {
    this.pgenerator = fn;
    this.pname = pname;
    this.toParent = toParent || noop;
    this.id = Symbol(pname);


    this.current = null;
    this.state = null;
    this.buffer = [];

    this.children = [];
    this.subscribers = [];
    this.exitWaiter = makeWaiter();
  }

  start(args) {
    const ctx = {
      pname: this.pname,
      fork: this.fork.bind(this),
      send: this.send.bind(this),
      toParent: this.toParent,
    };
    const task = watchExit(this)(ctx, ...args);
    this.current = task;
    let ret = task.next();
    this.state = ret.value;
    this._tick(task.next());
  }

  fork (fn, pname) {
    return (...args) => {
      const child =  new Process(fn, pname, this.fromChild.bind(this));
      this.children.push(child);
      child.start(args);
      return child;
    }
  }

  _tick (ret) {
    let msg;
    while(msg = this.buffer.shift()) {
      this._tick(this.current.next(msg));
    }
    this.notify();
    if (ret && ret.done) {
      this.exitWaiter.resolve();
      this.subscribers.splice(0, this.subscribers.length);
    }
  }

  toAllChildren(msg) {
    this.children.forEach(p => p.send(msg));
  }

  send(msg) {
    this.buffer.push(msg);
    defer(()=> this._tick());
  }

  _send(to, msg) {
    this._tick(to.next({ msg }));
  }

  notify() {
    this.subscribers.forEach((f) => f());
  }

  subscribe(f) {
    this.subscribers.push(f);
    return () => {
      const idx = this.subscribers.indexOf(f);
      if (idx < 0) {
        return;
      }
      this.subscribers.splice(idx, 1);
    }
  }

  wait() {
    return this.exitWaiter.promise;
  }

  fromChild(msg) {
    if (msg.type === 'EXIT') {
      this.children = this.children.filter(p=> p.id !== msg.pid);
    }
    this.send(msg);
  }
}
