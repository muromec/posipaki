import { defer, makeWaiter, debugLog, sleep } from "./util.js";
import type { DeferredCall, Waiter } from "./util.js";
import type {
  Message,
  WithSender,
  SenderInfo,
  ExitMessage,
  StopMessage,
  ProcessCtx,
  AsyncProcessFn,
  ProcessFn,
} from "./types.js";
import { asyncify } from "./adapters.js";

// ---- types ------------------------------------------------------------------

/** An async iterator over process state. Receives `WithSender<InMessage | StopMessage>`. */
type AsyncProcessGenerator<
  ProcessState,
  InMessage extends Message,
> = AsyncGenerator<
  ProcessState | null,
  void,
  WithSender<InMessage | StopMessage>
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

/** How long a parent waits for a child to stop before continuing shutdown. */
const CHILD_STOP_TIMEOUT_MS = 1_000;

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
  ReflectionMethods extends object,
> {
  /** Reflection methods.  Empty by default — defineActor fills in configured methods. */
  $reflection: ReflectionMethods = {} as ReflectionMethods;
  pgenerator: AsyncProcessFn<Args, State, InMessage, OutMessage>;
  pname: string;
  /** Called for every message sent via `ctx.toParent`. Receives `WithSender<OutMessage>`. */
  toParent: ProcessMessageCb<WithSender<OutMessage>>;
  id: symbol;
  state: State | null;

  private current: AsyncProcessGenerator<State, InMessage> | null = null;
  /** Every buffered message carries sender provenance. */
  private buffer: Array<WithSender<InMessage | StopMessage>> = [];
  private nextTick: DeferredCall | null = null;
  /** Child processes forked from this one (any fork method). */
  children: Array<
    AsyncProcess<unknown, unknown, Message, Message, {}>
  > = [];
  /** Children inherited from a child that exited (see ctx-orphans proposal). */
  orphans: Array<
    AsyncProcess<unknown, unknown, Message, Message, {}>
  > = [];
  private subscribers: Array<NotifyFn> = [];
  private exitWaiter: Waiter;
  private pvtIsPaused: boolean = false;
  private pvtTickInProgress: boolean = false;
  private pvtExitReject: ((e: unknown) => void) | null = null;
  private pvtReady!: Waiter;
  private pvtResolveReady!: () => void;

  constructor(
    fn: AsyncProcessFn<Args, State, InMessage, OutMessage>,
    pname: string,
    toParent: ProcessMessageCb<WithSender<OutMessage>> | undefined,
  ) {
    this.pgenerator = fn;
    this.pname = pname;
    this.toParent =
      toParent || (noop as ProcessMessageCb<WithSender<OutMessage>>);
    this.id = Symbol(pname);
    this.state = null;
    this.exitWaiter = makeWaiter();
    this.pvtReady = makeWaiter();
    this.pvtResolveReady = this.pvtReady.resolve;
  }

  /** Promise that resolves once the initial state is available. */
  ready(): Promise<void> {
    return this.pvtReady.promise;
  }

  // ---- lifecycle ------------------------------------------------------------

  /**
   * Kick off the async generator. The first `yield` sets the initial
   * state; for async generators this happens in a microtask.
   */
  start(arg0: Args, parentName?: string | null, parentId?: symbol | null) {
    const selfCtx: SenderInfo = { fromName: this.pname, fromId: this.id };

    const ctx: ProcessCtx<Args, State, InMessage, OutMessage> = {
      pname: this.pname,
      id: this.id,
      parentName: parentName ?? null,
      parentId: parentId ?? null,
      fork: this.fork.bind(this),
      forkSync: this.forkSync.bind(this),
      children: this.children,
      orphans: this.orphans,
      sendSelf: (msg) => {
        this.send([msg, selfCtx]);
      },
      toParent: (msg) => {
        this.toParent([msg, selfCtx] as WithSender<OutMessage>);
      },
    };

    this.current = this.pvtWatchExit(ctx, arg0);
    void this.current.next().then((ret: IteratorResult<State | null, void>) => {
      this.state = ret.value ?? null;
      this.pvtResolveReady();
      if (ret.done) {
        this.exitWaiter.resolve();
        return;
      }
      // Advance past the initial yield so the pvtWatchExit generator
      // runs its finally block (EXIT/STOP) and the inner generator
      // enters its dispatch loop.
      const advance: WithSender<InMessage | StopMessage> = [
        { type: "__ADVANCE__" } as InMessage,
        {
          fromName: "__internal__",
          fromId: Symbol("__internal__"),
        } as SenderInfo,
      ];
      this.pvtEatResult(this.current!.next(advance));
    });
    return this;
  }

  /** Wrap the user's generator so EXIT/STOP logic fires on completion. */
  private async *pvtWatchExit(
    ctx: ProcessCtx<Args, State, InMessage, OutMessage>,
    arg0: Args,
  ): AsyncProcessGenerator<State, InMessage> {
    try {
      yield* this.pgenerator(ctx, arg0);
    } finally {
      // Cascade: STOP every child and await its generator stopping.
      this.toAllChildren({ type: "STOP" });
      const children = [...this.children];
      const survivors: Array<
        AsyncProcess<unknown, unknown, Message, Message, {}>
      > = [];
      if (children.length > 0) {
        await Promise.all(
          children.map(async (child) => {
            const stopped = await Promise.race([
              child.wait().then(() => true),
              sleep(CHILD_STOP_TIMEOUT_MS).then(() => false),
            ]);
            if (!stopped) {
              console.warn(
                `posipaki: child "${child.pname}" did not stop within ${CHILD_STOP_TIMEOUT_MS}ms; continuing shutdown`,
              );
              survivors.push(child);
            }
          }),
        );
      }
      // Hand surviving children and inherited orphans up to the parent for
      // adoption (see ctx-orphans proposal). In-process only.
      const orphans = [...survivors, ...this.orphans];
      // ctx.toParent stamps sender info into a WithSender tuple
      ctx.toParent({ type: "EXIT", orphans } as unknown as OutMessage);
      if (ctx.afterExit) await ctx.afterExit();
    }
  }

  // ---- fork -----------------------------------------------------------------

  fork<ChildArgs, ChildState, ChildIM extends Message, ChildOM extends Message>(
    fn: AsyncProcessFn<ChildArgs, ChildState, ChildIM, ChildOM>,
    pname: string,
  ): (
    args: ChildArgs,
  ) => AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM, {}> {
    return (args: ChildArgs) => {
      const child = new AsyncProcess<
        ChildArgs,
        ChildState,
        ChildIM,
        ChildOM,
        {}
      >(
        fn,
        pname,
        this.fromChild.bind(this) as unknown as ProcessMessageCb<
          WithSender<ChildOM>
        >,
      );
      this.children.push(
        child as unknown as AsyncProcess<
          unknown,
          unknown,
          Message,
          Message,
          {}
        >,
      );
      child.start(args, this.pname, this.id);
      return child;
    };
  }

  forkSync<
    ChildArgs,
    ChildState,
    ChildIM extends Message,
    ChildOM extends InMessage,
  >(
    fn: ProcessFn<ChildArgs, ChildState, ChildIM, ChildOM>,
    pname: string,
  ): (
    args: ChildArgs,
  ) => AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM, {}> {
    return this.fork(asyncify(fn), pname);
  }

  // ---- message processing ---------------------------------------------------

  protected async pvtTick(): Promise<void> {
    if (!this.current || this.pvtTickInProgress) return;

    this.pvtTickInProgress = true;
    try {
      let msgAndSender: WithSender<InMessage | StopMessage> | undefined;
      let ret: IteratorResult<State | null, void> | null = null;
      while ((msgAndSender = this.buffer.shift()) !== undefined) {
        ret = await this.pvtSafeNext(msgAndSender);
        if (!ret || ret.done) break;
      }
      this.notify();
      this.pvtEatResult(ret);
    } catch (e) {
      this.pvtExitReject?.(e);
      this.pvtExitReject = null;
    } finally {
      this.pvtTickInProgress = false;
    }
  }

  /** Call `.next()` and redirect unhandled rejections. */
  private async pvtSafeNext(
    msgAndSender: WithSender<InMessage | StopMessage>,
  ): Promise<IteratorResult<State | null, void> | null> {
    try {
      return await this.current!.next(msgAndSender);
    } catch (e) {
      this.pvtExitReject?.(e);
      this.pvtExitReject = null;
      return { done: true, value: undefined };
    }
  }

  private pvtEatResult(
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

  /** Stamp and enqueue a message from a named sender (external API). */
  send(msg: InMessage | StopMessage, from?: SenderInfo): void;
  /** Enqueue a pre-stamped message (internal: fromChild, toAllChildren). */
  send(msgAndSender: WithSender<InMessage | StopMessage>): void;
  send(
    msgOrTuple: InMessage | StopMessage | WithSender<InMessage | StopMessage>,
    from?: SenderInfo,
  ): void {
    if ("type" in msgOrTuple) {
      this.buffer.push([
        msgOrTuple as InMessage | StopMessage,
        from as SenderInfo,
      ]);
    } else {
      this.buffer.push(msgOrTuple as WithSender<InMessage | StopMessage>);
    }
    this.pvtScheduleTick();
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

  private pvtScheduleTick(): void {
    if (this.pvtIsPaused) return;

    this.nextTick?.cancel();
    this.nextTick = defer(() => {
      this.nextTick = null;
      void this.pvtTick();
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
    this.pvtIsPaused = true;
  }

  resume(): void {
    this.pvtIsPaused = false;
    this.pvtScheduleTick();
  }

  // ---- waiting --------------------------------------------------------------

  /**
   * Returns a promise that resolves when the generator completes, or
   * rejects if an unhandled error occurs during message processing.
   */
  wait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pvtExitReject = reject;

      this.exitWaiter.promise.then(
        () => {
          this.pvtExitReject = null;
          resolve();
        },
        (e) => {
          this.pvtExitReject = null;
          reject(e);
        },
      );
    });
  }

  // ---- child messages -------------------------------------------------------

  /** Relays a child's message to this process. The message already carries
   *  sender provenance (stamped by the child's `ctx.toParent` wrapper). */
  private fromChild(msgAndSender: WithSender<InMessage | StopMessage>): void {
    const [msg, sender] = msgAndSender;
    if (msg.type === "EXIT") {
      // sender.fromId === child's id (set by child's ctx.toParent wrapper)
      this.children = this.children.filter((p) => p.id !== sender.fromId);
      const orphans = (msg as ExitMessage).orphans;
      if (orphans && orphans.length > 0) {
        this.orphans.push(...orphans);
      }
    }
    this.send(msgAndSender);
  }
}
export type AnyProcess = AsyncProcess<unknown, unknown, Message, Message, {}>;
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
): (args: Args) => AsyncProcess<Args, State, InMessage, OutMessage, {}> {
  return (args: Args) => {
    const proc = new AsyncProcess<Args, State, InMessage, OutMessage, {}>(
      fn,
      pname,
      toParent,
    );
    proc.start(args);
    return proc;
  };
}
