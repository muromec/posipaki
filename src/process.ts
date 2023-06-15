import { ExitMessage, watchExit, Waiter, defer, DeferredCall, makeWaiter } from './util';

export interface Message {
  type: string;
};

type ProcessGenerator<ProcessState, InMessage> =  Generator<ProcessState | null, void, InMessage>;
type Fork = <ChildArgs, ChildState, InMessage extends Message, OutMessage extends Message>(fn : ProcessFn<ChildArgs, ChildState, InMessage, OutMessage>, pname : string) => (args: ChildArgs) => Process<ChildArgs, ChildState, InMessage, OutMessage>;


export type ProcessFn<Args, State, InMessage, OutMessage> = (ctx: ProcessCtx<InMessage, OutMessage>, args: Args) => ProcessGenerator<State, InMessage>;
type ProcessMessageCb<M> = (msg: M) => void;

export type ProcessCtx<IM, OM> = {
  pname: string,
  fork: Fork,
  send: (msg: IM) => void,
  toParent: ProcessMessageCb<OM>,
};

type NotifyFn = () => void;
type UnsubscibeFn = () => void;

export function spawn<Args, State, InMessage extends Message=Message, OutMessage extends Message=ExitMessage>(fn: ProcessFn<Args, State, InMessage, OutMessage>, pname: string, toParent?: ProcessMessageCb<OutMessage>) {
  return (args: Args): Process<Args, State, InMessage, OutMessage> => {
    const process = new Process<Args, State, InMessage, OutMessage>(fn, pname, toParent);
    process.start(args);
    return process;
  };
}
const noop = ()=> null;

class Process<Args, State, InMessage extends Message, OutMessage extends Message> {
  pgenerator: ProcessFn<Args, State, InMessage, OutMessage>;
  pname: string;
  toParent: ProcessMessageCb<OutMessage>;
  id: Symbol;
  state: State | null;

  private current: ProcessGenerator<State, InMessage> | null;
  private buffer: Array<InMessage>;
  private nextTick: DeferredCall | null;
  private children: Array<Process<unknown, unknown, Message, Message>>;
  private subscribers: Array<NotifyFn>;
  private exitWaiter: Waiter;
  private _isPaused: boolean = false;

  constructor(fn: ProcessFn<Args, State, InMessage, OutMessage>, pname: string, toParent: ProcessMessageCb<OutMessage> | undefined) {
    this.pgenerator = fn;
    this.pname = pname;
    this.toParent = toParent || noop;
    this.id = Symbol(pname);


    this.current = null;
    this.state = null;
    this.buffer = [];
    this.nextTick = null;

    this.children = [];
    this.subscribers = [];
    this.exitWaiter = makeWaiter();
  }

  start(arg0: Args) {
    const ctx: ProcessCtx<InMessage, OutMessage> = {
      pname: this.pname,
      fork: this.fork.bind(this),
      send: this.send.bind(this),
      toParent: this.toParent,
    };
    const task = watchExit<Args, State, InMessage, OutMessage>(this)(ctx, arg0);
    this.current = task;
    let ret = task.next();
    this.state = ret.value || null;
    this._eatResult(task.next());
  }

  fork<ChildArgs, ChildState, ChildIM extends Message, ChildOM extends Message> (fn : ProcessFn<ChildArgs, ChildState, ChildIM, ChildOM>, pname : string) {
    return (args: ChildArgs): Process<ChildArgs, ChildState, ChildIM, ChildOM>  => {
      // not enough typescript power in this one
      const fromChild = this.fromChild.bind(this) as unknown;
      const child =  new Process<ChildArgs, ChildState, ChildIM, ChildOM>(fn, pname, fromChild as ProcessMessageCb<ChildOM>);
      // we don't keep track of what is happening down there
      this.children.push(child as unknown as Process<unknown, unknown, Message, Message>);
      child.start(args);
      return child;
    }
  }

  _tick () {
    if (!this.current) {
      return;
    }
    let msg: InMessage | undefined;
    let ret: IteratorResult<State | null, void> | null = null;
    while(msg = this.buffer.shift()) {
      ret = this.current.next(msg);
      if (ret.done) {
        break;
      }
    }
    this.notify();
    this._eatResult(ret);
  }

  _eatResult(ret: IteratorResult<State | null, void> | null) {
    if (ret && ret.done) {
      this.exitWaiter.resolve();
    }
  }

  toAllChildren(msg: Message) {
    this.children.forEach(p => p.send(msg));
  }

  send(msg: InMessage) {
    this.buffer.push(msg);
    this._scheduleTick();
  }

  tick() {
    this.nextTick?.flush();
    this.nextTick = null;
  }
  
  _scheduleTick() {
    if (this._isPaused) {
      return;
    }

    this.nextTick?.cancel();
    this.nextTick = defer(()=>  {
      this.nextTick = null;
      this._tick()
    });
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

  pause() {
    this.nextTick?.cancel();
    this.nextTick = null;
    this._isPaused = true;
  }

  resume() {
    this._isPaused = false;
    this._scheduleTick();
  }

  wait() {
    return this.exitWaiter.promise;
  }

  fromChild(msg: InMessage) {
    if (msg.type === 'EXIT') {
      this.children = this.children.filter(p=> p.id !== (msg as unknown as ExitMessage).pid);
    }
    this.send(msg);
  }
}

export default Process;
