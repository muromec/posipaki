import { defer, makeWaiter, debugLog } from "./util.js"
import type { DeferredCall, Waiter } from "./util.js"
import type { Message, ExitMessage, ProcessCtx, AsyncProcessFn } from "./types.js"

// ---- types ------------------------------------------------------------------

/** An async iterator over process state. */
type AsyncProcessGenerator<ProcessState, InMessage> = AsyncGenerator<
  ProcessState | null,
  void,
  InMessage
>;


type NotifyFn = () => void;

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
  toParent: ProcessMessageCb<OutMessage>;
  id: symbol;
  state: State | null;

  private current: AsyncProcessGenerator<State, InMessage> | null = null;
  private buffer: Array<InMessage> = [];
  private nextTick: DeferredCall | null = null;
  private children: Array<AsyncProcess<unknown, unknown, Message, Message>> =
    [];
  private subscribers: Array<NotifyFn> = [];
  private exitWaiter: Waiter;
  private _isPaused: boolean = false;
  private _tickInProgress: boolean = false;
  private _exitReject: ((e: unknown) => void) | null = null;

  constructor(
    fn: AsyncProcessFn<Args, State, InMessage, OutMessage>,
    pname: string,
    toParent: ProcessMessageCb<OutMessage> | undefined,
  ) {
    this.pgenerator = fn;
    this.pname = pname;
    this.toParent = toParent || (noop as ProcessMessageCb<OutMessage>);
    this.id = Symbol(pname);
    this.state = null;
    this.exitWaiter = makeWaiter();
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Kick off the async generator. The first `yield` sets the initial
   * state; for async generators this happens in a microtask.
   */
  start(arg0: Args): void {
    const ctx: ProcessCtx<InMessage, OutMessage> = {
      pname: this.pname,
      fork: this.fork.bind(this) as any,
      send: this.send.bind(this),
      toParent: this.toParent,
    };

    this.current = this._watchExit(ctx, arg0);
    // AsyncGenerator.next() always returns a Promise<IteratorResult>
    void this.current.next().then((ret: IteratorResult<State | null, void>) => {
      this.state = ret.value ?? null;
      // Prime the generator so it enters runDispatchAsync's `yield null`
      this._eatResult(this.current!.next());
    });
  }

  /** Wrap the user's generator so EXIT/STOP logic fires on completion. */
  private async *_watchExit(
    ctx: ProcessCtx<InMessage, OutMessage>,
    arg0: Args,
  ): AsyncProcessGenerator<State, InMessage> {
    try {
      yield* this.pgenerator(ctx, arg0);
    } finally {
      this.toAllChildren({ type: "STOP" } as Message);
      this.toParent({
        type: "EXIT",
        pid: this.id,
      } as unknown as OutMessage);
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
        this.fromChild.bind(this) as unknown as ProcessMessageCb<ChildOM>,
      );
      this.children.push(
        child as unknown as AsyncProcess<unknown, unknown, Message, Message>,
      );
      child.start(args);
      return child;
    };
  }

  // ---- message processing ---------------------------------------------------

  private async _tick(): Promise<void> {
    if (!this.current || this._tickInProgress) return;

    this._tickInProgress = true;
    try {
      let msg: InMessage | undefined;
      let ret: IteratorResult<State | null, void> | null = null;
      while ((msg = this.buffer.shift()) !== undefined) {
        ret = await this._safeNext(msg);
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
    msg: InMessage,
  ): Promise<IteratorResult<State | null, void> | null> {
    try {
      return await this.current!.next(msg);
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
    this.children.forEach((p) => p.send(msg));
  }

  /** Enqueue a message. Processing is async (microtask). */
  send(msg: InMessage): void {
    this.buffer.push(msg);
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

  private fromChild(msg: InMessage): void {
    if (msg.type === "EXIT") {
      this.children = this.children.filter(
        (p) => p.id !== (msg as unknown as ExitMessage).pid,
      );
    }
    this.send(msg);
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
  toParent?: ProcessMessageCb<OutMessage>,
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
