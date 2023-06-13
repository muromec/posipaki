import { watchExit, Waiter, defer, makeWaiter } from './util.js';

export type Message = {
  type: string;
};
type ExitMessage = {
  type: 'EXIT';
  pid: Symbol;
};

type ProcessGenerator<ProcessState> =  Generator<ProcessState, void, Message>;

type ProcessCtx = {
};

type ProcessFn<Args, State> = (ctx: ProcessCtx, args: Args) => ProcessGenerator<State>;
type ProcessMessageCb = (msg: Message | ExitMessage) => void;

type NotifyFn = () => void;
type UnsubscibeFn = () => void;

export type Pctx = {
};

export function spawn<Args, State>(fn: ProcessFn<Args, State>, pname: string, toParent: ProcessMessageCb) {
  return (args: Args): Process<Args, State> => {
    const process = new Process(fn, pname, toParent);
    process.start(args);
    return process;
  };
}
const noop = ()=> null;

class Process<Args, State> {
  pgenerator: ProcessFn<Args, State>;
  pname: string;
  toParent: ProcessMessageCb;
  id: Symbol;

  private current: ProcessGenerator<State> | null;
  private state: State | null;
  private buffer: Array<Message>;
  private children: Array<Process<unknown, unknown>>;
  private subscribers: Array<NotifyFn>;
  private exitWaiter: Waiter;

  constructor(fn: ProcessFn<Args, State>, pname: string, toParent: ProcessMessageCb | undefined) {
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

  start(arg0: Args) {
    const ctx: Pctx = {
      pname: this.pname,
      fork: this.fork.bind(this),
      send: this.send.bind(this),
      toParent: this.toParent,
    };
    const task = watchExit<Args, State>(this)(ctx, arg0);
    this.current = task;
    let ret = task.next();
    this.state = ret.value || null;
    this._tick(task.next());
  }

  fork<ChildArgs, ChildState> (fn : ProcessFn<ChildArgs, ChildState>, pname : string) {
    return (args: ChildArgs) => {
      const child =  new Process(fn, pname, this.fromChild.bind(this));
      this.children.push(child as Process<unknown, unknown>);
      child.start(args);
      return child;
    }
  }

  _tick (ret: IteratorResult<State, void> | null) {
    if (!this.current) {
      return;
    }

    let msg: Message | undefined;
    while(msg = this.buffer.shift()) {
      this._tick(this.current.next(msg));
    }
    this.notify();
    if (ret && ret.done) {
      this.exitWaiter.resolve();
      this.subscribers.splice(0, this.subscribers.length);
    }
  }

  toAllChildren(msg: Message) {
    this.children.forEach(p => p.send(msg));
  }

  send(msg: Message) {
    this.buffer.push(msg);
    defer(()=> this._tick(null));
  }

  notify() {
    this.subscribers.forEach((f) => f());
  }

  subscribe(f: NotifyFn) {
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

  fromChild(msg: Message | ExitMessage) {
    if (msg.type === 'EXIT') {
      this.children = this.children.filter(p=> p.id !== (msg as ExitMessage).pid);
    }
    this.send(msg);
  }
}

export default Process;
