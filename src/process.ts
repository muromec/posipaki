import {
  ExitMessage,
  watchExit,
  Waiter,
  defer,
  DeferredCall,
  makeWaiter,
} from "./util";
import type { Message } from "./types";

type ProcessGenerator<ProcessState, InMessage> = Generator<
  ProcessState | null,
  void,
  InMessage
>;
type Fork = <
  ChildArgs,
  ChildState,
  InMessage extends Message,
  OutMessage extends Message,
>(
  fn: ProcessFn<ChildArgs, ChildState, InMessage, OutMessage>,
  pname: string,
) => (args: ChildArgs) => Process<ChildArgs, ChildState, InMessage, OutMessage>;

/**
 * A process generator function. Receives a {@link ProcessCtx} and
 * initial args, yields state (or `null`) at each step.
 */
export type ProcessFn<Args, State, InMessage, OutMessage> = (
  ctx: ProcessCtx<InMessage, OutMessage>,
  args: Args,
) => ProcessGenerator<State, InMessage>;
type ProcessMessageCb<M> = (msg: M) => void;

/**
 * Context injected into every running process. Provides the process
 * name, ability to fork children, and I/O channels.
 */
export type ProcessCtx<IM, OM> = {
  pname: string;
  fork: Fork;
  send: (msg: IM) => void;
  toParent: ProcessMessageCb<OM>;
};

type NotifyFn = () => void;

/**
 * Spawn a new process from a process function. Returns a curried
 * function: call it with initial args to start execution.
 */
export function spawn<
  Args,
  State,
  InMessage extends Message = Message,
  OutMessage extends Message = ExitMessage,
>(
  fn: ProcessFn<Args, State, InMessage, OutMessage>,
  pname: string,
  toParent?: ProcessMessageCb<OutMessage>,
) {
  return (args: Args): Process<Args, State, InMessage, OutMessage> => {
    const process = new Process<Args, State, InMessage, OutMessage>(
      fn,
      pname,
      toParent,
    );
    process.start(args);
    return process;
  };
}
const noop = () => null;

/**
 * A running process — an actor with message-passing, child processes,
 * and observable state. Driven by a generator function that yields
 * state snapshots and receives messages via `yield` expressions.
 */
class Process<
  Args,
  State,
  InMessage extends Message,
  OutMessage extends Message,
> {
  pgenerator: ProcessFn<Args, State, InMessage, OutMessage>;
  pname: string;
  toParent: ProcessMessageCb<OutMessage>;
  id: symbol;
  state: State | null;

  private current: ProcessGenerator<State, InMessage> | null;
  private buffer: Array<InMessage>;
  private nextTick: DeferredCall | null;
  private children: Array<Process<unknown, unknown, Message, Message>>;
  private subscribers: Array<NotifyFn>;
  private exitWaiter: Waiter;
  private _isPaused: boolean = false;

  constructor(
    fn: ProcessFn<Args, State, InMessage, OutMessage>,
    pname: string,
    toParent: ProcessMessageCb<OutMessage> | undefined,
  ) {
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

  private _initWaiter: Waiter = makeWaiter();

  /** Promise that resolves once the initial state is available. */
  ready(): Promise<void> {
    return this._initWaiter.promise;
  }

  /** Kick off the generator with initial arguments. */
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
    this._initWaiter.resolve();
    this._eatResult(task.next());
  }

  /** Fork a child process. Children forward messages to this process
   * and send `EXIT` when they terminate. */
  fork<ChildArgs, ChildState, ChildIM extends Message, ChildOM extends Message>(
    fn: ProcessFn<ChildArgs, ChildState, ChildIM, ChildOM>,
    pname: string,
  ) {
    return (
      args: ChildArgs,
    ): Process<ChildArgs, ChildState, ChildIM, ChildOM> => {
      // not enough typescript power in this one
      const fromChild = this.fromChild.bind(this) as unknown;
      const child = new Process<ChildArgs, ChildState, ChildIM, ChildOM>(
        fn,
        pname,
        fromChild as ProcessMessageCb<ChildOM>,
      );
      // we don't keep track of what is happening down there
      this.children.push(
        child as unknown as Process<unknown, unknown, Message, Message>,
      );
      child.start(args);
      return child;
    };
  }

  _tick() {
    if (!this.current) {
      return;
    }
    let msg: InMessage | undefined;
    let ret: IteratorResult<State | null, void> | null = null;
    while ((msg = this.buffer.shift())) {
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

  /** Send a message to every child process (used for `STOP` propagation). */
  toAllChildren(msg: Message) {
    this.children.forEach((p) => p.send(msg));
  }

  /** Send a message to this process. Messages are buffered and
   * processed asynchronously via a microtask. */
  send(msg: InMessage) {
    this.buffer.push(msg);
    this._scheduleTick();
  }

  /** Synchronously flush the message buffer. Useful in tests. */
  tick(): void {
    this.nextTick?.flush();
    this.nextTick = null;
  }

  /** Async version of tick — returns a promise that resolves
   *  after all buffered messages have been processed. */
  async tickAsync(): Promise<void> {
    this.nextTick?.cancel();
    this.nextTick = null;
    this._tick();
  }

  _scheduleTick() {
    if (this._isPaused) {
      return;
    }

    this.nextTick?.cancel();
    this.nextTick = defer(() => {
      this.nextTick = null;
      this._tick();
    });
  }

  notify() {
    this.subscribers.forEach((f) => f());
  }

  /** Whether any subscribers are watching for state changes. */
  get isListenedTo() {
    return this.subscribers.length > 0;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(f: NotifyFn) {
    this.subscribers.push(f);
    return () => {
      const idx = this.subscribers.indexOf(f);
      if (idx < 0) {
        return;
      }
      this.subscribers.splice(idx, 1);
    };
  }

  /** Pause message processing. Incoming messages are buffered
   * but not processed until {@link resume} is called. */
  pause() {
    this.nextTick?.cancel();
    this.nextTick = null;
    this._isPaused = true;
  }

  /** Resume processing after a {@link pause}. */
  resume() {
    this._isPaused = false;
    this._scheduleTick();
  }

  /** Return a promise that resolves when the generator completes. */
  wait() {
    return this.exitWaiter.promise;
  }

  /** Handle a message forwarded from a child process. `EXIT` removes
   * the child; all other messages are forwarded to `send`. */
  fromChild(msg: InMessage) {
    if (msg.type === "EXIT") {
      this.children = this.children.filter(
        (p) => p.id !== (msg as unknown as ExitMessage).pid,
      );
    }
    this.send(msg);
  }
}

export { Process };
