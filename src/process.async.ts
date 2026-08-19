import { defer, makeWaiter, debugLog, withTimeout } from "./util.js";
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

/** A subscriber to this process's message channel: receives the message and
 *  its sender separately (not a `WithSender` tuple). */
type MessageCallback<M extends Message> = (msg: M, from: SenderInfo) => void;


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
  /** Subscribers to this process's message channel (`ctx.toParent`). */
  private messageSubscribers: Array<MessageCallback<OutMessage>> = [];
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
  private stateSubscribers: Array<NotifyFn> = [];
  /** Unsubscribe handles for outgoing message subscriptions (adopt/monitor). */
  private pvtOutgoingSubscriptions: Array<() => void> = [];
  private exitWaiter: Waiter;
  private pvtIsPaused: boolean = false;
  private pvtDead: boolean = false;
  private pvtTickInProgress: boolean = false;
  private pvtExitReject: ((e: unknown) => void) | null = null;
  private pvtReady!: Waiter;
  private pvtResolveReady!: () => void;

  constructor(
    fn: AsyncProcessFn<Args, State, InMessage, OutMessage>,
    pname: string,
    toParent?: MessageCallback<OutMessage>,
  ) {
    this.pgenerator = fn;
    this.pname = pname;
    if (toParent) this.messageSubscribers.push(toParent);
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

    const ctx: ProcessCtx<Args, State, InMessage, OutMessage | ExitMessage> = {
      pname: this.pname,
      id: this.id,
      parentName: parentName ?? null,
      parentId: parentId ?? null,
      fork: this.fork.bind(this),
      forkSync: this.forkSync.bind(this),
      children: this.children,
      orphans: this.orphans,
      adopt: this.adopt.bind(this),
      monitor: this.monitor.bind(this),
      sendSelf: (msg) => {
        this.send([msg, selfCtx]);
      },
      toParent: (msg) => {
        this.messageSubscribers.forEach((cb) => cb(msg as OutMessage, selfCtx));
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
    ctx: ProcessCtx<Args, State, InMessage, OutMessage | ExitMessage>,
    arg0: Args,
  ): AsyncProcessGenerator<State, InMessage> {
    try {
      yield* this.pgenerator(ctx, arg0);
    } finally {
      // Cascade: STOP every child and await its generator stopping.
      this.toAllChildren({ type: "STOP" });

      const orphans: Array<AnyProcess> = [...this.orphans];
      const stopPromises = this.children.map(async (child) => {
        try {
          await withTimeout(child.wait(), CHILD_STOP_TIMEOUT_MS, 'childStop');
        } catch (e) {
          if ((e as Error)?.message !== 'Timeout:childStop') {
            throw e;
          }

          orphans.push(child);
          console.warn(
            `posipaki: child "${child.pname}" did not stop within ${CHILD_STOP_TIMEOUT_MS}ms; continuing shutdown`,
          );
        }
      });

      await Promise.all(stopPromises);
      // Hand surviving children and inherited orphans up to the parent for adoption (see ctx-orphans proposal).
      // In-process only.
      ctx.toParent({ type: "EXIT", orphans });
      // Unsubscribe from children/monitored processes so a dead parent
      // doesn't keep receiving their messages.
      for (const unsub of this.pvtOutgoingSubscriptions) unsub();
      this.pvtOutgoingSubscriptions = [];
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
      >(fn, pname);
      this.adopt(child);
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
    if (this.pvtDead) return;
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
    if (this.pvtIsPaused || this.pvtDead) return;

    this.nextTick?.cancel();
    this.nextTick = defer(() => {
      this.nextTick = null;
      void this.pvtTick();
    });
  }

  // ---- subscribers ----------------------------------------------------------

  notify(): void {
    this.stateSubscribers.forEach((f) => f());
  }

  get isListenedTo(): boolean {
    return this.stateSubscribers.length > 0;
  }

  subscribe(channel: "message", cb: MessageCallback<OutMessage>): () => void;
  subscribe(channel: "state", cb: NotifyFn): () => void;
  /** @deprecated Use `subscribe("state", cb)`. */
  subscribe(cb: NotifyFn): () => void;
  subscribe(
    channelOrCb: "message" | "state" | NotifyFn,
    cb?: MessageCallback<OutMessage> | NotifyFn,
  ): () => void {
    if (typeof channelOrCb === "function") {
      return this.subscribe("state", channelOrCb);
    }
    if (channelOrCb === "message") {
      const fn = cb as MessageCallback<OutMessage>;
      this.messageSubscribers.push(fn);
      return () => this.pvtUnsubscribe(this.messageSubscribers, fn);
    }
    const fn = cb as NotifyFn;
    this.stateSubscribers.push(fn);
    return () => this.pvtUnsubscribe(this.stateSubscribers, fn);
  }

  private pvtUnsubscribe<T>(list: Array<T>, fn: T): void {
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  // ---- pause / resume -------------------------------------------------------

  /**
   * Freeze dispatch: no further ticks are scheduled, so the process stops
   * *processing* incoming messages.  This is half-working as a "quiesce"
   * primitive — it does not stop the process from *emitting* via async
   * callbacks (timers, fetch) that bypass the dispatch loop.
   */
  pause(): void {
    this.nextTick?.cancel();
    this.nextTick = null;
    this.pvtIsPaused = true;
  }

  resume(): void {
    this.pvtIsPaused = false;
    this.pvtScheduleTick();
  }

  /**
   * Hard-kill this process: abandon the generator without running its
   * `finally` (no EXIT, no STOP cascade), drop the inbox and observers,
   * unsubscribe from children/monitors, and settle `wait()`/`ready()`.
   *
   * There is nothing to observe afterward — callers remove the process from
   * their `children`/`orphans` lists imperatively.  Does not cascade to this
   * process's own children; they are abandoned (force-stop them separately if
   * owned).
   *
   * Best-effort: an idle generator (suspended at `yield`) is abandoned
   * cleanly; a generator mid-`await` completes its `finally` when that await
   * settles, because JS offers no way to cancel a pending promise.
   */
  forceStop(): void {
    if (this.pvtDead) return;
    this.pvtDead = true;

    // Abandon the generator so its finally block never runs.
    this.current = null;

    // Drop the inbox and stop scheduling.
    this.buffer.length = 0;
    this.nextTick?.cancel();
    this.nextTick = null;

    // Release incoming observers and outgoing subscriptions.
    this.messageSubscribers.length = 0;
    this.stateSubscribers.length = 0;
    for (const unsub of this.pvtOutgoingSubscriptions) unsub();
    this.pvtOutgoingSubscriptions = [];

    // Settle waiters.
    this.pvtResolveReady();
    this.exitWaiter.resolve();
    this.pvtExitReject = null;
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

  /**
   * Tap another process's message channel: every message it emits is fed
   * into this process's incoming queue.  No ownership — the sender's EXIT
   * does not touch `children`/`orphans`.
   */
  monitor<ChildArgs, ChildState, ChildIM extends Message, ChildOM extends Message>(
    child: AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM, {}>,
  ): () => void {
    const unsub = child.subscribe("message", (msg, from) => {
      this.send([msg, from] as WithSender<InMessage | StopMessage>);
    });
    this.pvtOutgoingSubscriptions.push(unsub);
    return unsub;
  }

  /**
   * Claim another process as a child: its messages are routed here and its
   * EXIT removes it from `children` (collecting its orphans).  Generalizes
   * what `fork` does — used for both spawning and orphan adoption.
   */
  adopt<ChildArgs, ChildState, ChildIM extends Message, ChildOM extends Message>(
    child: AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM, {}>,
  ): () => void {
    this.children.push(child as unknown as AnyProcess);
    const unsub = child.subscribe("message", (msg, from) => {
      this.pvtChildMessage(msg, from);
    });
    this.pvtOutgoingSubscriptions.push(unsub);
    return unsub;
  }

  /** Handles a child's emitted message: EXIT cleanup + forward to the queue. */
  private pvtChildMessage(msg: Message, sender: SenderInfo): void {
    if (msg.type === "EXIT") {
      // sender.fromId === child's id (stamped by the child's ctx.toParent)
      // Mutate in place so ctx.children (a live reference) stays consistent.
      const idx = this.children.findIndex((p) => p.id === sender.fromId);
      if (idx >= 0) this.children.splice(idx, 1);
      const orphans = (msg as ExitMessage).orphans;
      if (orphans && orphans.length > 0) {
        this.orphans.push(...orphans);
      }
    }
    this.send([msg, sender] as WithSender<InMessage | StopMessage>);
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
  toParent?: MessageCallback<OutMessage>,
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
