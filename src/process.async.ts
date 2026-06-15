import { defer, makeWaiter, debugLog } from "./util.js";
import type { DeferredCall, Waiter } from "./util.js";
import type {
  Message,
  WithSender,
  SenderInfo,
  ExitMessage,
  ProcessCtx,
  AsyncProcessFn,
  ProcessFn,
  Fork,
} from "./types.js";
import { asyncify } from "./adapters.js";

// ---- types ------------------------------------------------------------------

/** An async iterator over process state. Receives `WithSender<InMessage>`. */
type AsyncProcessGenerator<ProcessState, InMessage extends Message> =
  AsyncGenerator<ProcessState | null, void, WithSender<InMessage>>;

type NotifyFn = () => void;

// ---- sendFrom ---------------------------------------------------------------

/** Stamp a plain message with sender provenance. */
export function sendFrom<M extends Message>(
  msg: M,
  from: { pname: string; id: symbol },
): WithSender<M> {
  return [msg, { fromName: from.pname, fromId: from.id }];
}

// ---- runDispatchAsync -------------------------------------------------------

type AsyncReducer<M> = (msg: M) => Promise<void>;
type ReadyFn = () => boolean;

/**
 * Async equivalent of `runDispatch`. Loops, yielding `null` and feeding
 * each incoming message to an `async` reducer. Exits when `readyFn()`
 * returns true.
 */
export async function* runDispatchAsync<M>(
  name: string,
  fn: AsyncReducer<M>,
  readyFn: ReadyFn = () => false,
  debugLevel = false,
): AsyncGenerator<null, void, M> {
  let msg: M;
  while (!readyFn()) {
    msg = yield null;
    debugLog(debugLevel, "msg", name, " <- ", msg);
    await fn(msg);
  }
}

// ---- AsyncProcess -----------------------------------------------------------

type ProcessMessageCb<M> = (msg: M) => void;

const noop = () => null;

/**
 * A process driven by an async generator. Functionally identical to
 * {@link Process} but supports `await` inside reducers.
 *
 * Messages are processed **one at a time** — if a tick is already
 * in-flight, new messages are buffered and processed when the current
 * tick completes.
 */
export class AsyncProcess<
  Args,
  State,
  InMessage extends Message,
  OutMessage extends Message,
> {
  pgenerator: AsyncProcessFn<Args, State, InMessage, OutMessage>;
  pname: string;
  /** Called for every message sent via `ctx.toParent`. Receives `WithSender<OutMessage>`. */
  toParent: ProcessMessageCb<WithSender<OutMessage>>;
  id: symbol;
  state: State | null;

  private current: AsyncProcessGenerator<State, InMessage> | null = null;
  /** Every buffered message carries sender provenance. */
  private buffer: Array<WithSender<InMessage>> = [];
  private nextTick: DeferredCall | null = null;
  private children: Array<AsyncProcess<unknown, unknown, Message, Message>> =
    [];
  private subscribers: Array<NotifyFn> = [];
  private exitWaiter: Waiter;
  private _isPaused: boolean = false;
  private _tickInProgress: boolean = false;
  private _exitReject: ((e: unknown) => void) | null = null;
  private _ready!: Waiter;
  private _resolveReady!: () => void;

  constructor(
    fn: AsyncProcessFn<Args, State, InMessage, OutMessage>,
    pname: string,
    toParent: ProcessMessageCb<WithSender<OutMessage>> | undefined,
  ) {
    this.pgenerator = fn;
    this.pname = pname;
    this.toParent = toParent || (noop as ProcessMessageCb<WithSender<OutMessage>>);
    this.id = Symbol(pname);
    this.state = null;
    this.exitWaiter = makeWaiter();
    this._ready = makeWaiter();
    this._resolveReady = this._ready.resolve;
  }

  /** Promise that resolves once the initial state is available. */
  ready(): Promise<void> {
    return this._ready.promise;
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Kick off the async generator. The first `yield` sets the initial
   * state; for async generators this happens in a microtask.
   */
  start(arg0: Args) {
    const selfCtx: SenderInfo = { fromName: this.pname, fromId: this.id };

    const ctx: ProcessCtx<Args, State, InMessage, OutMessage> = {
      pname: this.pname,
      id: this.id,
      fork: this.fork.bind(this),
      forkSync: this.forkSync.bind(this),
      send: (msg) => {
        this.send(msg);
      },
      toParent: (msg) => {
        this.toParent([msg, selfCtx] as WithSender<OutMessage>);
      },
    };

    this.current = this._watchExit(ctx, arg0);
    void this.current.next().then((ret: IteratorResult<State | null, void>) => {
      this.state = ret.value ?? null;
      this._resolveReady();
      if (ret.done) {
        this.exitWaiter.resolve();
        return;
      }
      // Advance past the initial yield so the _watchExit generator
      // runs its finally block (EXIT/STOP) and the inner generator
      // enters its dispatch loop.
      const advance: WithSender<InMessage> = [
        { type: "__ADVANCE__" } as InMessage,
        { fromName: "__internal__", fromId: Symbol("__internal__") },
      ];
      this._eatResult(this.current!.next(advance));
    });
    return this;
  }

  /** Wrap the user's generator so EXIT/STOP logic fires on completion. */
  private async *_watchExit(
    ctx: ProcessCtx<Args, State, InMessage, OutMessage>,
    arg0: Args,
  ): AsyncProcessGenerator<State, InMessage> {
    try {
      yield* this.pgenerator(ctx, arg0);
    } finally {
      this.toAllChildren({ type: "STOP" });
      // ctx.toParent stamps sender info into a WithSender tuple
      ctx.toParent({ type: "EXIT", pid: this.id } as unknown as OutMessage);
    }
  }

  // ---- fork -----------------------------------------------------------------

  fork<ChildArgs, ChildState, ChildIM extends Message, ChildOM extends Message>(
    fn: AsyncProcessFn<ChildArgs, ChildState, ChildIM, ChildOM>,
    pname: string,
  ): (
    args: ChildArgs,
  ) => AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM> {
    return (args: ChildArgs) => {
      const child = new AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM>(
        fn,
        pname,
        this.fromChild.bind(this) as unknown as ProcessMessageCb<
          WithSender<ChildOM>
        >,
      );
      this.children.push(
        child as unknown as AsyncProcess<unknown, unknown, Message, Message>,
      );
      child.start(args);
      return child;
    };
  }

  forkSync<
    ChildArgs,
    ChildState,
    ChildIM extends Message,
    ChildOM extends Message,
  >(
    fn: ProcessFn<ChildArgs, ChildState, ChildIM, ChildOM>,
    pname: string,
  ): (
    args: ChildArgs,
  ) => AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM> {
    return this.fork(asyncify(fn), pname);
  }

  // ---- message processing ---------------------------------------------------

  protected async _tick(): Promise<void> {
    if (!this.current || this._tickInProgress) return;

    this._tickInProgress = true;
    try {
      let msgAndSender: WithSender<InMessage> | undefined;
      let ret: IteratorResult<State | null, void> | null = null;
      while ((msgAndSender = this.buffer.shift()) !== undefined) {
        ret = await this._safeNext(msgAndSender);
        if (!ret || ret.done) break;
      }
      this.notify();
      this._eatResult(ret);
    } catch (e) {
      this._exitReject?.(e);
      this._exitReject = null;
    } finally {
      this._tickInProgress = false;
    }
  }

  /** Call `.next()` and redirect unhandled rejections. */
  private async _safeNext(
    msgAndSender: WithSender<InMessage>,
  ): Promise<IteratorResult<State | null, void> | null> {
    try {
      return await this.current!.next(msgAndSender);
    } catch (e) {
      this._exitReject?.(e);
      this._exitReject = null;
      return { done: true, value: undefined };
    }
  }

  private _eatResult(
    ret:
      | IteratorResult<State | null, void>
      | Promise<IteratorResult<State | null, void>>
      | null,
  ): void {
    if (!ret) return;
    Promise.resolve(ret).then((r) => {
      if (r.done) {
        this.exitWaiter.resolve();
      }
    });
  }

  /** Broadcast a message to all children. */
  toAllChildren(msg: Message): void {
    const stamp: SenderInfo = { fromName: this.pname, fromId: this.id };
    this.children.forEach((p) => p.send([msg, stamp] as WithSender<Message>));
  }

  /** Enqueue a plain message — stamp with this process's identity. */
  send(msg: InMessage): void;
  /** Enqueue a pre-stamped message (e.g. from sendFrom or fromChild). */
  send(msgAndSender: WithSender<InMessage>): void;
  send(msgOrStamped: InMessage | WithSender<InMessage>): void {
    if (Array.isArray(msgOrStamped)) {
      this.buffer.push(msgOrStamped);
    } else {
      this.buffer.push([msgOrStamped, { fromName: this.pname, fromId: this.id }]);
    }
    this._scheduleTick();
  }

  /**
   * Synchronously flush the buffer. For sync processes use {@link Process.tick};
   * for async processes this is **not guaranteed** to process everything
   * immediately if reducers contain `await`. Prefer `send()` + `await proc.wait()`.
   */
  tick(): void {
    this.nextTick?.flush();
    this.nextTick = null;
  }

  private _scheduleTick(): void {
    if (this._isPaused) return;

    this.nextTick?.cancel();
    this.nextTick = defer(() => {
      this.nextTick = null;
      void this._tick();
    });
  }

  // ---- subscribers ----------------------------------------------------------

  notify(): void {
    this.subscribers.forEach((f) => f());
  }

  get isListenedTo(): boolean {
    return this.subscribers.length > 0;
  }

  subscribe(f: NotifyFn): () => void {
    this.subscribers.push(f);
    return () => {
      const idx = this.subscribers.indexOf(f);
      if (idx < 0) return;
      this.subscribers.splice(idx, 1);
    };
  }

  // ---- pause / resume -------------------------------------------------------

  pause(): void {
    this.nextTick?.cancel();
    this.nextTick = null;
    this._isPaused = true;
  }

  resume(): void {
    this._isPaused = false;
    this._scheduleTick();
  }

  // ---- waiting --------------------------------------------------------------

  /**
   * Returns a promise that resolves when the generator completes, or
   * rejects if an unhandled error occurs during message processing.
   */
  wait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._exitReject = reject;

      this.exitWaiter.promise.then(
        () => {
          this._exitReject = null;
          resolve();
        },
        (e) => {
          this._exitReject = null;
          reject(e);
        },
      );
    });
  }

  // ---- child messages -------------------------------------------------------

  /** Relays a child's message to this process. The message already carries
   *  sender provenance (stamped by the child's `ctx.toParent` wrapper). */
  private fromChild(msgAndSender: WithSender<InMessage>): void {
    const [msg] = msgAndSender;
    if (msg.type === "EXIT") {
      this.children = this.children.filter(
        (p) => p.id !== (msg as unknown as ExitMessage).pid,
      );
    }
    this.send(msgAndSender);
  }
}

// ---- spawnAsync -------------------------------------------------------------

/**
 * Spawn a new async process. Accepts both sync and async process
 * functions — sync ones are automatically wrapped with {@link asyncify}.
 */
export function spawnAsync<
  Args,
  State,
  InMessage extends Message = Message,
  OutMessage extends Message = ExitMessage,
>(
  fn: AsyncProcessFn<Args, State, InMessage, OutMessage>,
  pname: string,
  toParent?: ProcessMessageCb<WithSender<OutMessage>>,
): (args: Args) => AsyncProcess<Args, State, InMessage, OutMessage> {
  return (args: Args) => {
    const proc = new AsyncProcess<Args, State, InMessage, OutMessage>(
      fn,
      pname,
      toParent,
    );
    proc.start(args);
    return proc;
  };
}
