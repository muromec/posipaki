import { watchExit, Waiter, defer, makeWaiter } from './util.js';

export type Message = {
  type: string;
};
type ExitMessage = {
  type: 'EXIT';
  pid: Symbol;
};

type ProcessGenerator<ProcessState> =  Generator<ProcessState | null, void, Message>;
type Fork<ChildArgs, ChildState> = (fn : ProcessFn<ChildArgs, ChildState>, pname : string) => (args: ChildArgs) => Process<ChildArgs, ChildState>;


export type ProcessFn<Args, State> = (ctx: ProcessCtx, args: Args) => ProcessGenerator<State>;
type ProcessMessageCb = (msg: Message | ExitMessage) => void;

export type ProcessCtx = {
  pname: string,
  fork: Fork<unknown, unknown>,
  send: (msg: Message) => void,
  toParent: ProcessMessageCb,
};

type NotifyFn = () => void;
type UnsubscibeFn = () => void;

export function spawn<Args, State>(fn: ProcessFn<Args, State>, pname: string, toParent?: ProcessMessageCb) {
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
  state: State | null;

  private current: ProcessGenerator<State> | null;
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
    const ctx: ProcessCtx = {
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

  _tick (ret: IteratorResult<State | null, void> | null) {
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

  get isListenedTo() {
    return this.subscribers.length > 0;
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