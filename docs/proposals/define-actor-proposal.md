# posipaki: `defineActor` — high-level actor wrapper

> **Status**: Draft proposal. No code written yet.

## Summary

`defineActor` is a declarative wrapper around the existing `runDispatch` /
`AsyncProcess` primitives.  It keeps the low-level generator API unchanged
and adds a higher layer that every real actor in the email-agent codebase
would benefit from:

- Named message handlers instead of `if/switch` chains
- Automatic `fromName` / `fromId` stamping on every outbound message
- Clean separation between **internal state** (what handlers mutate) and
  **exposed state** (what `proc.state` returns to external consumers)
- Lifecycle hooks: `onStart`, `onStopRequested`, `onEnd`, `onChildExit`, `onUnhandled`
- **Built-in STOP and EXIT handling** — STOP calls `onStopRequested` (actor
  can accept or defer); EXIT from children is intercepted automatically
- Dynamic child management with `this.fork()` and `this.$child[name]`

The existing `spawn`, `spawnAsync`, `runDispatch`, `runDispatchAsync`, and
`Process` / `AsyncProcess` classes remain untouched.  `defineActor` compiles
down to those primitives — it is purely a convenience layer.

## Motivation

Every non-trivial actor in the codebase follows the same pattern:

```ts
async function* myActor(ctx, args) {
  let done = false;
  const state = { ... };
  yield state;

  // fork children (repetitive currying)
  const child1 = ctx.fork(fn1, "child1")(args1);
  const child2 = ctx.fork(fn2, "child2")(args2);

  // giant if/else dispatch
  yield* runDispatchAsync("myActor", async (msg) => {
    if (msg.type === "STOP")      { done = true; return; }
    if (msg.type === "RESPONSE")  { ... }
    if (msg.type === "EXIT")      { ... }
    if (msg.type === "HEARTBEAT") { ... }
    // 8 more...
  }, () => done);
}
```

The pain points, collected from real actors:

1. **Boilerplate**: `done` flag, `yield state`, `yield* runDispatch(...)` — identical
   in every file.
2. **Stringly-typed dispatch**: `if (msg.type === "...")` with no exhaustiveness
   check, no editor autocomplete for handled types.
3. **Child management**: `ctx.fork(...)(args)` is noisy.  Tracking which child
   exited requires matching `msg.pid` against `child.id` in the same
   handler that deals with application messages.
4. **Provenance**: Every child-message routing problem is solved ad-hoc with
   `withFromId` / `withFromIdSync`, which manually patches `ctx.toParent`.
5. **Lifecycle**: No hooks — setup code sits between `yield state` and
   `yield* runDispatch`, cleanup is spread across `STOP` handling and
   the generator `finally` block.
6. **STOP/EXIT boilerplate**: Every actor defines `{ type: "STOP" }` in its
   message union and writes the same `STOP() { this.exit(); }` handler.
   EXIT from children requires matching `msg.pid` against `child.id`.

These aren't defects in the primitives — `runDispatch` is a fine low-level
building block.  But the email-agent actors are all written at the same
abstraction level as the runtime internals.

## Built-in lifecycle signals

Two message types are universal — every process sends EXIT, every process
may receive STOP.  The low-level runtime already handles both:

- `AsyncProcess._watchExit` (the `finally` block wrapping every generator):
  sends `{ type: "STOP" }` to all children, then `{ type: "EXIT", pid, fromName, fromId }` to the parent
- `AsyncProcess.fromChild`: filters EXITed children from `this.children[]`

`defineActor` builds on this infrastructure.  STOP and EXIT are intercepted
before they reach the `handlers` record.  The actor author never defines
`StopMessage` or writes a STOP handler.

### STOP → `onStopRequested`

```
STOP arrives
  → onStopRequested() fires
      → actor can call this.agreeToStop() to accept (same as this.exit("stopped"))
      → actor can defer — continues processing messages
      → if onStopRequested is omitted, this.agreeToStop() is the default
  → once agreed (via agreeToStop, explicit this.exit(), or child exit cascading):
      → dispatch loop exits
      → onEnd(reason) fires (final cleanup: kill PTY, close connections, …)
      → generator returns
      → _watchExit sends STOP to all low-level children, EXIT to parent
```

The separation: `onStopRequested` is the **decision point** — "they want me
to stop, do I agree?"  `onEnd` is the **cleanup point** — "I am stopping
now, clean up whatever is left."  An actor can agree immediately, defer
(process a queue first), or, in principle, never agree.

The actor does **not** need to manually send STOP to children — the runtime's
`_watchExit` does it automatically when the generator returns.  Cleanup of
non-process resources (file handles, timers, network connections) belongs in
`onEnd`.

### EXIT from children — automatic

```
EXIT arrives with fromName
  → if fromName matches a child in $child:
      → remove child from $child
      → call onChildExit(name, reason) if provided
      → EXIT is consumed — does not reach handlers or onUnhandled
  → if fromName is unknown (not a recognized child):
      → forwarded to onUnhandled (the actor can decide what to do)
```

The actor never sees EXIT from its own children in its message handlers —
`onChildExit` is the dedicated hook.  EXIT from unknown processes (which
should not normally occur) falls through to `onUnhandled`.

## Internal state vs. exposed state

A key insight from real usage: the state that **handlers mutate** is often a
different type from the state that **external consumers read**.  The
supervisor actor wraps its state with Vue's `reactive()` before yielding it.
Handlers mutate a plain object; subscribers read a reactive proxy.

`defineActor` makes this distinction explicit with two type parameters:

| Type parameter | What it is | Who sees it |
|---|---|---|
| `InternalState` | The state handlers work with (`this.state`) | `onStart`, `onStopRequested`, handlers, `onEnd`, `onChildExit`, `onUnhandled` |
| `ExposedState` | The state external consumers see (`proc.state`) | Subscribers, parent processes, computed properties |

When no `expose` function is provided, `InternalState` and `ExposedState`
are the same type — the simple case.  When `expose` is provided, it bridges
them:

```ts
// Without expose — simple case:
const actor = defineActor<Args, { count: number }, { count: number }, In, Out>({
  initialState: { count: 0 },
  // InternalState = ExposedState = { count: number }
  // this.state.count === proc.state.count (same object)
});

// With expose — separate worlds:
const actor = defineActor<Args, PlainState, ReactiveState, In, Out>({
  initialState(args): PlainState {
    return { count: 0, items: [] };
  },
  expose(raw: PlainState): ReactiveState {
    return reactive(raw);  // Vue reactive proxy
  },
  // this.state has type PlainState
  // proc.state has type ReactiveState
});
```

## Proposed API

### Quick example

```ts
import { defineActor } from "posipaki";

const pool = defineActor<PoolArgs, PoolInternal, PoolExposed, PoolInMessage, PoolOutMessage>({
  initialState(args) {
    return { free: 0, queued: 0 };
  },

  expose(raw) {
    return raw;
  },

  onStart(args) {
    for (let i = 0; i < args.size; i++) {
      this.fork(args.workerFn, `w${i}`, args.workerArgs);
    }
    this.state.free = args.size;
  },

  // No onStopRequested — default (agree immediately) is fine for a pool.
  // No onEnd — nothing to clean up beyond what _watchExit handles.

  handlers: {
    USER_MESSAGE(msg) {
      this.state.queued++;
    },
  },

  onUnhandled(msg) {
    // Messages from workers carry fromName; parent messages don't.
    const fromName: string | undefined = (msg as Message & { fromName?: string }).fromName;
    if (fromName && fromName.startsWith("w")) {
      this.emit(msg as PoolOutMessage);
      this.state.free++;
      this._flushQueue();
    } else {
      this._dispatchToWorker(msg);
    }
  },

  onChildExit(name, reason) {
    this.state.free--;
    this._flushQueue();
    if (Object.keys(this.$child).filter(k => k.startsWith("w")).length === 0) {
      this.exit("no workers left");
    }
  },
});
```

### The full config object

```ts
interface ActorConfig<Args, InternalState, ExposedState, InMsg extends Message, OutMsg extends Message> {
  // ── state ──────────────────────────────────────────────────────────

  /**
   * Initial internal state, yielded to the runtime.  `proc.ready()`
   * resolves after the first yield.
   *
   * Can be a literal or a function that receives the spawn args.
   * A literal is equivalent to `(args) => literal`.
   */
  initialState: InternalState | ((args: Args) => InternalState);

  /**
   * Optional transformation from internal state to exposed state.
   * When provided:
   *
   *   - `this.state` inside the actor is of type `InternalState`
   *   - `proc.state` to external consumers is of type `ExposedState`
   *
   * Use this for Vue's `reactive()` wrapping or similar reactivity
   * systems that wrap the raw object in a proxy.
   *
   * When omitted, `ExposedState` defaults to `InternalState` and
   * `this.state` and `proc.state` point to the same object.
   */
  expose?: (internalState: InternalState) => ExposedState;

  // ── lifecycle ──────────────────────────────────────────────────────

  /**
   * Called after initial state is yielded, before the first message
   * is dispatched.  Receives the spawn args.  Can be async.
   *
   * This is where you typically fork children via `this.fork()`.
   */
  onStart?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    args: Args,
  ) => void | Promise<void>;

  /**
   * Called when a STOP message is received.  The actor decides
   * whether to stop now or defer:
   *
   *   - Call `this.agreeToStop()` to accept immediately.
   *   - Don't call it — continue processing messages.  STOP is
   *     polled: it will be offered again after each subsequent
   *     message until the actor agrees.
   *   - Call `this.exit(reason)` for a custom exit reason.
   *
   * If `onStopRequested` is omitted, the default behavior is
   * `this.agreeToStop()` — the actor accepts STOP immediately.
   *
   * Typical deferral: drain a queue before stopping.
   * ```ts
   * onStopRequested() {
   *   if (this.state.queued > 0) {
   *     // Don't call agreeToStop — will be offered again.
   *     this.state.stopping = true;
   *   } else {
   *     this.agreeToStop();
   *   }
   * }
   * ```
   */
  onStopRequested?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
  ) => void | Promise<void>;

  /**
   * Called after the dispatch loop exits — the actor is stopping.
   * The `reason` is:
   *
   *   - `"stopped"` — STOP was received and `agreeToStop` was called
   *     (or `onStopRequested` was omitted, accepting the default)
   *   - whatever was passed to `this.exit(reason)` — explicit exit
   *   - whatever reason a child exit cascaded into `this.exit()`
   *   - `"done"` — the generator returned naturally (shouldn't
   *     normally happen with the built-in dispatch loop)
   *
   * Can be async.  The runtime's `_watchExit` sends STOP to all
   * children and EXIT to the parent after `onEnd` returns — the
   * actor does not need to do this manually.
   */
  onEnd?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    reason?: unknown,
  ) => void | Promise<void>;

  // ── message handlers ───────────────────────────────────────────────

  /**
   * Handlers keyed by message type.  Each handler receives the
   * narrowed message type and `this` bound to the actor context.
   *
   * STOP and EXIT from children are intercepted before they reach
   * handlers — see "Built-in lifecycle signals" above.  EXIT from
   * unknown processes falls through to `onUnhandled`.
   *
   * Unmatched message types fall through to `onUnhandled`.
   */
  handlers: {
    [K in InMsg["type"]]?: (
      this: ActorContext<Args, InternalState, InMsg, OutMsg>,
      msg: Extract<InMsg, { type: K }>,
    ) => void | Promise<void>;
  };

  /**
   * Called for every message whose `type` is not matched by
   * `handlers` and is not intercepted by the built-in STOP/EXIT
   * handling.  Receives the full `InMsg` union — use type
   * narrowing (or leave unhandled) as needed.
   *
   * Typical uses:
   *   - Routing child messages by `fromName` (pool pattern)
   *   - Forwarding unknown messages to the parent (Erlang-style)
   *   - Logging and ignoring unexpected message types in production
   *
   * If omitted, unhandled messages are silently dropped.
   */
  onUnhandled?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    msg: InMsg,
  ) => void | Promise<void>;

  // ── children ───────────────────────────────────────────────────────

  /**
   * Called when a child process exits.  `name` is the string name
   * passed to `this.fork()`.  `reason` is the EXIT message.
   *
   * This hook is called automatically — EXIT from children never
   * reaches `handlers` or `onUnhandled`.  The child is removed
   * from `$child` before this hook fires.
   */
  onChildExit?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    name: string,
    reason: ExitMessage,
  ) => void | Promise<void>;
}
```

### The handler context (`this`)

Inside `onStart`, `onStopRequested`, handlers, `onEnd`, `onChildExit`,
and `onUnhandled`, `this` provides:

```ts
interface ActorContext<Args, InternalState, InMsg extends Message, OutMsg extends Message> {
  /** Mutable internal state reference.  This is the raw object
   *  returned by `initialState` — not the exposed proxy.
   *  Changes are visible to subscribers after the tick completes
   *  (they read `proc.state`, which is the exposed version). */
  state: InternalState;

  /** The process name (same as ctx.pname). */
  name: string;

  /** The unique process id (Symbol). */
  id: symbol;

  /** Send a message to the parent.  The actor context automatically
   *  stamps `fromName` and `fromId` on the message before delivery. */
  emit: (msg: OutMsg) => void;

  /**
   * Accept a STOP request.  Equivalent to `this.exit("stopped")`.
   *
   * Only meaningful inside `onStopRequested`.  After this is called,
   * the dispatch loop exits and `onEnd("stopped")` fires.
   *
   * Calling `agreeToStop` outside of `onStopRequested` has the same
   * effect as `this.exit("stopped")`.
   */
  agreeToStop: () => void;

  /** Exit the dispatch loop.  Calls `onEnd` with the given reason,
   *  then the generator returns (triggering STOP→children, EXIT→parent
   *  via the low-level _watchExit wrapper). */
  exit: (reason?: unknown) => void;

  // ── children ─────────────────────────────────────────────────────

  /**
   * Named children, populated from `this.fork()` calls.  Each value
   * is the child process handle.
   *
   * **Type-erased**: `$child` is typed as `AsyncProcess<unknown, unknown,
   * Message, Message>`.  For fully typed child access, capture the
   * return value of `this.fork()`:
   *
   * ```ts
   * onStart(args) {
   *   this._connector = this.fork(connector, "connector", args);
   *   // this._connector.send(...) — fully typed
   *   // this.$child.connector     — name-based lookup, type-erased
   * }
   * ```
   *
   * `$child` is for name-based operations: looking up by name when
   * you only have a string (e.g. from `msg.fromName`), or counting
   * children.  For everyday typed interaction, capture the `fork()`
   * return.
   */
  $child: Record<string, AsyncProcess<unknown, unknown, Message, Message>>;

  /**
   * Fork a child process.  Returns a **typed** child handle.
   * Registers the child in `this.$child[name]` for name-based lookup.
   *
   * Accepts either a raw process function or an `ActorDefinition`
   * (the return value of `defineActor`).  Sync process functions are
   * automatically wrapped via `asyncify`.
   *
   * ```ts
   * // From a raw AsyncProcessFn:
   * const c = this.fork(connectorFn, "connector", { history, ... });
   * c.send({ type: "APPEND", ... });  // fully typed
   *
   * // From an ActorDefinition:
   * const c = this.fork(connector, "connector", { history, ... });
   * c.send({ type: "APPEND", ... });  // fully typed
   * ```
   */
  fork<A, S, IM extends Message, OM extends Message>(
    fn: AsyncProcessFn<A, S, IM, OM> | ProcessFn<A, S, IM, OM> | ActorDefinition<A, S, IM, OM>,
    name: string,
    args?: A,
  ): AsyncProcess<A, S, IM, OM>;

  /** Raw process context (the low-level ctx passed to generators).
   *  Available for escape hatches.  Fully typed with this actor's
   *  Args, InternalState, InMsg, and OutMsg parameters. */
  ctx: ProcessCtx<Args, InternalState, InMsg, OutMsg>;
}
```

### Working with children — the pattern

Children are almost always forked, not spawned standalone.  The primary
way to interact with a child is through the typed handle returned by
`this.fork()`.  `this.$child[name]` is a secondary access path for
name-based operations.

```ts
const openaiActor = defineActor<OpenAIActorArgs, OpenAIInternal, OpenAIExposed, In, Out>({
  onStart(args) {
    this._connector = this.fork(connector, "connector", {
      history: args.history,
      toolDefs,
      token: args.token,
      baseUrl: args.baseUrl,
      model: args.model,
    });

    this._tools = this.fork(pool, "tools", { tools: args.tools });
  },

  handlers: {
    RESPONSE(msg) {
      this._connector.send({ type: "APPEND", ... });
    },
  },

  onStopRequested() {
    // Agree to stop immediately — default behavior.
    // An actor with a queue could defer: check this.state.pending,
    // only call this.agreeToStop() when the queue is drained.
    this.agreeToStop();
  },

  onEnd(reason) {
    // _watchExit sends STOP to connector and tools automatically.
    // Only non-process cleanup goes here (file handles, timers, …).
  },

  onChildExit(name, reason) {
    if (name === "connector") {
      this._connector = undefined;
    }
  },
});
```

The `this._connector` / `this._tools` convention (underscore-prefixed
private fields on `this`) keeps typed handles accessible across all
lifecycle hooks without polluting the `$child` namespace.

### Type signature

`defineActor` has five type parameters.  `ExposedState` defaults to
`InternalState`, so the simple case needs only four:

```ts
function defineActor<
  Args,
  InternalState,
  ExposedState = InternalState,
  InMsg extends Message = Message,
  OutMsg extends Message = Message,
>(
  config: ActorConfig<Args, InternalState, ExposedState, InMsg, OutMsg>
): ActorDefinition<Args, ExposedState, InMsg, OutMsg>;
```

`InMsg` no longer needs to include a `StopMessage` member — STOP is
handled by the infrastructure.  EXIT from children also never appears
in `InMsg`.

**Simple case (no expose):**

```ts
// ExposedState defaults to InternalState.
const actor = defineActor<Args, MyState, MyState, In, Out>({ ... });
// Or rely on inference:
const actor = defineActor({ initialState: { count: 0 }, ... });
```

**With expose:**

```ts
const actor = defineActor<Args, Plain, Reactive<Plain>, In, Out>({
  initialState(args): Plain { return { count: 0 }; },
  expose(raw: Plain): Reactive<Plain> { return reactive(raw); },
  // this.state: Plain
  // proc.state: Reactive<Plain>
});
```

### Return value

```ts
interface ActorDefinition<Args, ExposedState, InMsg extends Message, OutMsg extends Message> {
  fn: AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>;
  spawn: (name: string, args: Args) => AsyncProcess<Args, ExposedState, InMsg, OutMsg>;
  config: ActorConfig<Args, InternalState, ExposedState, InMsg, OutMsg>;
}
```

Usage:

```ts
const myActor = defineActor({ ... });

// Fork as a child (primary use case — this.fork() accepts ActorDefinition directly):
//   this.fork(myActor, "name", args);

// Spawn standalone:
const proc = myActor.spawn("myName", args);
// proc.state has type ExposedState
```

## Automatic message stamping

### fromName / fromId on normal messages

Every message sent via `this.emit(msg)` is stamped with:

```ts
{
  fromName: "connector",  // string — the process name (ctx.pname)
  fromId: ctx.id,         // symbol — the process id
}
```

### fromName / fromId on EXIT — harmonized

The existing EXIT message shape is extended to carry the same
`fromName` / `fromId` fields as normal stamped messages:

```ts
// Before:
{ type: "EXIT", pid: Symbol(...) }

// After:
{ type: "EXIT", pid: Symbol(...), fromName: "connector", fromId: Symbol("connector") }
```

`pid` is retained for backward compatibility.  `fromId` and `pid` carry
the same symbol value on EXIT.  New code uses `fromId` and `fromName` —
the same fields that appear on every other child message.

### Field summary

| Field | Type | On normal messages | On EXIT |
|-------|------|--------------------|---------|
| `fromName` | `string` | ✅ (stamped by `emit`) | ✅ (stamped by `_watchExit`) |
| `fromId` | `symbol` | ✅ (stamped by `emit`) | ✅ (stamped by `_watchExit`) |
| `pid` | `symbol` | ❌ | ✅ (existing, retained — same value as `fromId`) |

## Migration example: worker pool

### Before (current `pool.ts`, simplified)

```ts
export const pool: AsyncProcessFn<PoolArgs, PoolState, Message | (Message & FromIdMessage), Message> =
  async function* pool(ctx, { size, workerFn, workerArgs }) {
    const slots: WorkerSlot[] = [];
    const queue: Message[] = [];
    let done = false;

    const stampedWorker = withFromId(workerFn);

    for (let i = 0; i < size; i++) {
      const name = `w${i}`;
      const proc = ctx.fork(stampedWorker, name)(workerArgs);
      slots.push({ name, proc, free: true });
    }

    yield { free: size, queued: 0 };

    yield* runDispatchAsync("pool", async (msg) => {
      if (msg.type === "EXIT") {
        const pid = (msg as any).pid;
        const slot = slots.find((s) => s.proc.id === pid);
        if (slot) {
          removeWorker(slot.name);
          flushQueue();
        }
        if (slots.length === 0) done = true;
        return;
      }
      if (msg.type === "STOP") {
        done = true;
        for (const s of slots) s.proc.send({ type: "STOP" });
        return;
      }
      if ("fromId" in msg && typeof (msg as FromIdMessage).fromId === "string") {
        const fromId = (msg as FromIdMessage).fromId;
        freeSlot(fromId);
        ctx.toParent(msg);
        flushQueue();
        return;
      }
      dispatchToWorker(msg);
    }, () => done);
  };
```

### After (with defineActor)

```ts
// PoolInMessage no longer includes StopMessage or ExitMessage.
// No onStopRequested — default (agree immediately) is fine.
// No onEnd — _watchExit handles child cleanup.
const pool = defineActor<PoolArgs, PoolState, PoolState, PoolInMessage, PoolOutMessage>({
  initialState(args) {
    return { free: args.size, queued: 0 };
  },

  onStart(args) {
    for (let i = 0; i < args.size; i++) {
      this._workers[i] = this.fork(args.workerFn, `w${i}`, args.workerArgs);
    }
  },

  onUnhandled(msg) {
    const fromName: string | undefined = (msg as Message & { fromName?: string }).fromName;
    if (fromName && fromName.startsWith("w")) {
      // Worker response — mark free, forward to parent.
      this.emit(msg as PoolOutMessage);
      this.state.free++;
      this._flushQueue();
    } else {
      // Parent message — dispatch to a worker.
      this._dispatchToWorker(msg);
    }
  },

  onChildExit(name, reason) {
    this.state.free--;
    this._flushQueue();
    if (Object.keys(this.$child).filter(k => k.startsWith("w")).length === 0) {
      this.exit("no workers left");
    }
  },
});
```

The worker identification is handled by `fromName` automatically — no
`withFromId` wrapper, no string check against `fromId`, no `pid` matching.
STOP is handled by the infrastructure.  EXIT from workers never reaches
the message handlers — `onChildExit` receives it directly.

## Implementation sketch

```ts
function defineActor<
  Args,
  InternalState,
  ExposedState = InternalState,
  InMsg extends Message = Message,
  OutMsg extends Message = Message,
>(
  config: ActorConfig<Args, InternalState, ExposedState, InMsg, OutMsg>
): ActorDefinition<Args, ExposedState, InMsg, OutMsg> {

  const fn: AsyncProcessFn<Args, ExposedState, InMsg, OutMsg> =
    async function* (ctx, args) {
      let done = false;
      let exitReason: unknown;
      let stopRequested = false;

      // Resolve internal state — literal or function of args.
      const rawState: InternalState = typeof config.initialState === "function"
        ? (config.initialState as (args: Args) => InternalState)(args)
        : config.initialState;

      // Apply expose if provided, otherwise identity.
      const exposedState: ExposedState = config.expose
        ? config.expose(rawState)
        : rawState as unknown as ExposedState;

      // Build the actor context.
      const self: ActorContext<Args, InternalState, InMsg, OutMsg> = {
        state: rawState,
        name: ctx.pname,
        id: ctx.id,
        emit(msg) {
          ctx.toParent({
            ...msg,
            fromName: ctx.pname,
            fromId: ctx.id,
          } as OutMsg);
        },
        agreeToStop() {
          exitReason = "stopped";
          done = true;
        },
        exit(reason) {
          exitReason = reason;
          done = true;
        },
        $child: {},
        fork<A, S, IM extends Message, OM extends Message>(
          fn: AsyncProcessFn<A, S, IM, OM> | ProcessFn<A, S, IM, OM> | ActorDefinition<A, S, IM, OM>,
          name: string,
          args?: A,
        ): AsyncProcess<A, S, IM, OM> {
          const resolvedFn: AsyncProcessFn<A, S, IM, OM> | ProcessFn<A, S, IM, OM> =
            typeof fn === "function" ? fn : fn.fn;
          const child = ctx.fork(resolvedFn, name)(args);
          self.$child[name] = child;
          return child;
        },
        ctx,
      };

      // Yield the exposed state — external consumers see this.
      yield exposedState;

      // Call onStart with args.
      if (config.onStart) {
        await config.onStart.call(self, args);
      }

      // Dispatch loop.
      yield* runDispatchAsync(
        ctx.pname,
        async (msg: InMsg) => {
          // ── Built-in STOP handling ──────────────────────────────────
          if (msg.type === "STOP") {
            if (config.onStopRequested) {
              await config.onStopRequested.call(self);
              // onStopRequested may or may not have called agreeToStop/exit.
              // If it didn't, we continue processing — STOP is re-offered
              // after each subsequent message (see below).
              if (!done) {
                stopRequested = true;
              }
            } else {
              // Default: agree immediately.
              exitReason = "stopped";
              done = true;
            }
            return;
          }

          // ── Re-offer deferred STOP ──────────────────────────────────
          // If STOP was requested but the actor deferred, ask again
          // after every application message.
          if (stopRequested && !done) {
            if (config.onStopRequested) {
              await config.onStopRequested.call(self);
              // If the actor still hasn't agreed, keep the flag up.
              if (!done) {
                stopRequested = true;
              }
            }
          }

          // ── Built-in EXIT handling ──────────────────────────────────
          if (msg.type === "EXIT") {
            const exitMsg = msg as unknown as ExitMessage;
            const childName = exitMsg.fromName;

            if (childName && self.$child[childName]) {
              // Recognized child — consume EXIT here.
              delete self.$child[childName];
              if (config.onChildExit) {
                await config.onChildExit.call(self, childName, exitMsg);
              }
              return;
            }

            // Unrecognized EXIT — fall through to handlers/onUnhandled.
          }

          // ── Named handlers ──────────────────────────────────────────
          if (msg.type !== "STOP") {
            const handler = (config.handlers as Record<string, ((msg: InMsg) => void | Promise<void>) | undefined>)[msg.type];
            if (handler) {
              await handler.call(self, msg);
            } else if (config.onUnhandled) {
              await config.onUnhandled.call(self, msg);
            }
            // No onUnhandled: silently drop.
          }

          if (done) return;
        },
        () => done,
      );

      // Call onEnd.  The low-level _watchExit will send STOP to all
      // children and EXIT to the parent after this generator returns.
      if (config.onEnd) {
        await config.onEnd.call(self, exitReason ?? "done");
      }
    };

  return {
    fn,
    spawn(name, args) {
      return spawnAsync(fn, name)(args);
    },
    config,
  };
}
```

## TypeScript narrowing

The `handlers` record provides type narrowing automatically:

```ts
handlers: {
  USER_MESSAGE(m) { /* m: UserMessage — m.content, m.replyTo, etc. */ },
  RESPONSE(m)     { /* m: ResponseMessage */ },
  TOOL_RESULT(m)  { /* m: MToolResult */ },
}
```

`onUnhandled` receives the full `InMsg` union — no narrowing, since by
definition the message type wasn't matched:

```ts
onUnhandled(msg: InMsg) {
  if (msg.type === "TAB_OUTPUT" || msg.type === "TAB_PROMPT") { ... }
}
```

## Backward compatibility

All existing APIs remain unchanged:

- `spawn`, `spawnAsync`, `runDispatch`, `runDispatchAsync` — unchanged.
- `Process`, `AsyncProcess` — unchanged.
- `ProcessFn`, `AsyncProcessFn`, `ProcessCtx` — unchanged.
- `Message` — gains optional `fromName?: string` and `fromId?: symbol`.
- `ExitMessage` — gains optional `fromName?: string` and `fromId?: symbol`.
  `pid: symbol` is retained.  `fromId` and `pid` carry the same value.
- `withFromId` / `withFromIdSync` — remain available but become unnecessary
  for new code.

`defineActor` can be imported alongside the existing primitives.  New actors
use the high-level API; existing actors continue to work without changes.

## What this removes from the codebase

| Current pattern | Replaced by |
|---|---|
| `let done = false; yield state; yield* runDispatch(...)` | `defineActor({ initialState, handlers })` |
| `if (msg.type === "STOP") { done = true; ... }` in every actor | `onStopRequested()` — default accepts immediately; defer available |
| `interface StopMessage { type: "STOP" }` in every InMsg union | Removed from InMsg — STOP is intercepted automatically |
| `if (msg.type === "EXIT" && msg.pid === child.id)` | `onChildExit(name, reason)` — compare `reason.fromId === child.id` |
| `withFromId(fn)` | Automatic — `fromName`/`fromId` on every emit |
| `ctx.fork(fn, name)(args)` | `this.fork(fn, name, args)` |
| `ctx.toParent(msg)` | `this.emit(msg)` (auto-stamped) |
| Manual child-by-pid matching | `msg.fromId === child.id` or `this.$child[msg.fromName]` |
| `forkSync` vs `fork` | Single `this.fork()` — detects sync/async automatically |
| Vue `reactive()` applied manually in generator body | `expose` config — declarative, type-checked bridge |

## Open questions

1. **STOP re-offer timing**: When `onStopRequested` defers (doesn't call
   `agreeToStop`), STOP is re-offered after every subsequent message.
   Is this too aggressive?  Alternative: a `checkStop()` method the
   actor calls explicitly when it's ready, or a configurable poll
   interval.  Proposal: keep the eager re-offer — it's simple and
   matches "the actor knows when it's ready."

2. **Can an actor refuse STOP indefinitely?**  In principle, yes — the
   `onStopRequested` hook can never call `agreeToStop`.  This is a
   feature, not a bug: an actor managing a critical resource might
   defer until it reaches a safe point.  Whether a parent should
   have a "force kill" mechanism is a separate question for the
   low-level runtime (e.g. `proc.kill()`).

3. **Handler return values**: Currently handlers return `void`.  Some
   patterns benefit from being able to return a value that controls
   dispatch flow.  Not needed for the initial version.

4. **Error handling in handlers**: If a handler throws, should the actor
   exit?  Currently unhandled rejections in async reducers are caught by
   `AsyncProcess._safeNext` and reject `wait()`.  We should preserve this:
   thrown errors → `wait()` rejection, same as today.

5. **Should `defineActor` support sync process functions?**  Initial
   version produces `AsyncProcessFn`.  Sync support can be added later.

6. **Declarative children**: A `children: { name: fn }` config block that
   auto-forks children before `onStart` could be added later, but is
   out of scope for this round.

7. **Five type parameters**: `<Args, InternalState, ExposedState, In, Out>`
   is more verbose than `<Args, State, In, Out>`.  `ExposedState` defaults
   to `InternalState`, so the common case only needs four.  Inference
   handles most cases.

8. **`fromId` and `pid` on EXIT**: Both carry the same symbol value.
   Proposal: keep `pid` indefinitely for backward compatibility,
   document `fromId` as preferred for new code.

## Implementation checklist

- [ ] `ExitMessage` gains optional `fromName?: string; fromId?: symbol`
- [ ] `AsyncProcess._watchExit` stamps `fromName`/`fromId` on EXIT
- [ ] `Process._watchExit` stamps `fromName`/`fromId` on EXIT (via shared `watchExit`)
- [ ] `Message` gains optional `fromName?: string; fromId?: symbol`
- [ ] `defineActor` function in new `src/define-actor.ts`
- [ ] `onStopRequested` hook — actor receives STOP, can call `this.agreeToStop()` or defer
- [ ] Default (no `onStopRequested`): `agreeToStop` is called immediately
- [ ] Deferred STOP: re-offered after each subsequent message until agreed
- [ ] `this.agreeToStop()` on context — convenience for `this.exit("stopped")`
- [ ] Built-in EXIT handling: matches `fromName` to `$child`, removes child, calls `onChildExit`
- [ ] Unrecognized EXIT (no matching `fromName`) falls through to `onUnhandled`
- [ ] `ActorContext` typed with all four `<Args, InternalState, InMsg, OutMsg>` params
- [ ] `ctx` field typed as `ProcessCtx<Args, InternalState, InMsg, OutMsg>`
- [ ] `initialState` supports both literal and `(args: Args) => InternalState`
- [ ] `onStart` receives `args`
- [ ] `expose` bridge: `(internalState: InternalState) => ExposedState`
- [ ] When `expose` omitted, `InternalState = ExposedState` (default type parameter)
- [ ] `this.state` is `InternalState`, `proc.state` / yielded value is `ExposedState`
- [ ] `this.fork()` fully generic — preserves child `<A, S, IM, OM>` types
- [ ] `this.fork()` accepts `ActorDefinition` directly, unwraps `.fn` internally
- [ ] `$child` typed as `Record<string, AsyncProcess<unknown, unknown, Message, Message>>`
- [ ] `ActorDefinition.spawn()` convenience method present
- [ ] `fromId` is `symbol` (not string) on both normal messages and EXIT
- [ ] `fromId` and `pid` carry the same symbol value on EXIT
- [ ] `onUnhandled` is a top-level hook
- [ ] `onUnhandled` receives `InMsg` (full union — un-narrowed)
- [ ] `onChildExit` receives `name` and `reason`; `reason.fromId` is usable for symbol comparison
- [ ] `this.fork()` registers child in `this.$child[name]`
- [ ] TypeScript: `handlers` record narrows message types
- [ ] TypeScript: full `<Args, InternalState, ExposedState, In, Out>` generic with default
- [ ] Tests: STOP with no `onStopRequested` → `agreeToStop` implied, `onEnd("stopped")` fires
- [ ] Tests: STOP with `onStopRequested` that calls `agreeToStop()` → `onEnd("stopped")` fires
- [ ] Tests: STOP with `onStopRequested` that defers → processing continues, STOP re-offered after next message
- [ ] Tests: deferred STOP → actor eventually calls `agreeToStop` → `onEnd("stopped")` fires
- [ ] Tests: `this.agreeToStop()` outside `onStopRequested` → equivalent to `this.exit("stopped")`
- [ ] Tests: EXIT from child → `onChildExit` fires, child removed from `$child`
- [ ] Tests: EXIT from unknown process → falls through to `onUnhandled`
- [ ] Tests: `onStart` receives args
- [ ] Tests: `expose` wrapping — handlers mutate InternalState, proc.state reflects ExposedState
- [ ] Tests: no `expose` — InternalState and ExposedState are the same object
- [ ] Tests: child forking via `this.fork()` preserves types on returned handle
- [ ] Tests: `this.fork()` accepts ActorDefinition
- [ ] Tests: `onChildExit` called with correct name; `reason.fromId === child.id`
- [ ] Tests: `onUnhandled` receives unhandled message types
- [ ] Tests: `fromName`/`fromId` stamping on emit (`fromId` is symbol)
- [ ] Tests: EXIT carries `fromName`/`fromId` with same values as normal messages from same child
- [ ] Tests: `fromId` and `pid` match on EXIT
- [ ] Tests: migration of `pool.ts` to defineActor (verifies real-world usage)
- [ ] Update `src/index.ts` exports
- [ ] Bump minor version
