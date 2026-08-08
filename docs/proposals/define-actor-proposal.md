# posipaki: `defineActor` — high-level actor wrapper

> **Status**: Implemented (0.14.0+). This document captures the original proposal
> and the implemented API. See also [setup/afterStart hooks](setup-afterstart-hooks.md)
> for the full lifecycle.

## Summary

`defineActor` is a declarative wrapper around the existing `runDispatch` /
`AsyncProcess` primitives.  It keeps the low-level generator API unchanged
and adds a higher layer that every real actor in the email-agent codebase
would benefit from:

- Named message handlers instead of `if/switch` chains
- Automatic `fromName` / `fromId` stamping on every outbound message
- Clean separation between **internal state** (what handlers mutate) and
  **exposed state** (what `proc.state` returns to external consumers)
- Lifecycle hooks: `setup`, `onStart`, `afterStart`, `onStopRequested`, `onEnd`,
  `onChildExit`, `onUnhandled`
- **Built-in STOP and EXIT handling** — STOP calls `onStopRequested` (actor
  can accept or defer); EXIT from children is intercepted automatically
- Dynamic child management with `this.fork()` and `this.$child[name]`

The existing `spawn`, `spawnAsync`, `runDispatch`, `runDispatchAsync`, and
`Process` / `AsyncProcess` classes remain untouched.  `defineActor` compiles
down to those primitives — it is purely a convenience layer.

## Lifecycle order

The full lifecycle of a `defineActor` actor, in order:

```
setup(args)       → returns InternalState (async, replaces initialState + onStart)
expose(state)     → ExposedState (bridges internal → external type)
onStart(args)     → legacy hook, mutates state in-place
hooks.onStart     → plugin hooks
yield exposedState → proc.ready() resolves — external consumers see ExposedState
afterStart()      → post-ready side effects (async, runs after consumers can observe state)
dispatch loop     → message handlers
onEnd(reason)     → cleanup
```

### setup() vs initialState + onStart

`setup()` is the **preferred** path for new code. It returns the initial
`InternalState` (or a `Promise<InternalState>`), replacing both `initialState`
and `onStart`. It runs before the first yield, so `proc.ready()` resolves with
fully-populated state.

| Hook | When | Returns | this.state available? | Preferred? |
|------|------|---------|-----------------------|------------|
| `setup(args)` | Before yield | `InternalState \| Promise<InternalState>` | Yes (after return) | ✅ |
| `initialState(args)` | Before yield | `InternalState` | No | Legacy |
| `onStart(args)` | After setup, before yield | `void` | Yes (mutates in-place) | Legacy |

`setup()` takes precedence: if both `setup` and `initialState` are provided,
`setup` wins. `initialState` alone is still supported for simple cases with
no async initialization.

### afterStart()

Fires after the first yield, before the dispatch loop begins. Use for
post-ready side effects — things that need to happen after subscribers can
observe the state but before message processing starts.

```ts
defineActor({
  async setup(args) {
    const child = this.fork(childFn, "worker");
    return { child };
  },
  async afterStart() {
    // Child is spawned, state is visible — send initial message.
    this.state.child.send({ type: "INIT", config: loadConfig() });
  },
  handlers: { /* ... */ },
});
```

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
| `InternalState` | The state handlers work with (`this.state`) | `setup`, `onStart`, `onStopRequested`, handlers, `onEnd`, `onChildExit`, `onUnhandled` |
| `ExposedState` | The state external consumers see (`proc.state`) | Subscribers, parent processes, computed properties |

When no `expose` function is provided, `InternalState` and `ExposedState`
are the same type — the simple case.  When `expose` is provided, it bridges
them:

```ts
// Without expose — simple case:
const actor = defineActor<Args, { count: number }, { count: number }, In, Out>({
  setup() {
    return { count: 0 };
  },
  // InternalState = ExposedState = { count: number }
  // this.state.count === proc.state.count (same object)
});

// With expose — separate worlds:
const actor = defineActor<Args, PlainState, ReactiveState, In, Out>({
  setup(args): PlainState {
    return { count: 0, items: [] };
  },
  expose(raw: PlainState): ReactiveState {
    return reactive(raw);  // Vue reactive proxy
  },
  // this.state has type PlainState
  // proc.state has type ReactiveState
});
```

## Implemented API

### Quick example

```ts
import { defineActor } from "posipaki";

const pool = defineActor<PoolArgs, PoolInternal, PoolExposed, PoolInMessage, PoolOutMessage>({
  async setup(args) {
    // Spawn children before first yield.  proc.ready() waits for this.
    for (let i = 0; i < args.size; i++) {
      this.fork(args.workerFn, `w${i}`, args.workerArgs);
    }
    return { free: args.size, queued: 0 };
  },

  expose(raw) {
    return raw;
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
      this.state.free++;
    }
  },
});
```

### ActorConfig fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `setup` | `(args) => InternalState \| Promise<InternalState>` | No¹ | Async state init before first yield |
| `initialState` | `InternalState \| ((args) => InternalState)` | No¹ | Legacy sync state init |
| `expose` | `(InternalState) => ExposedState` | No | Bridge internal → exposed types |
| `name` | `string` | No | Preferred process name |
| `afterStart` | `() => void \| Promise<void>` | No | Post-yield side effects |
| `onStart` | `(args) => void \| Promise<void>` | No | Legacy hook, mutates state in-place |
| `onStopRequested` | `() => void \| Promise<void>` | No | STOP decision point |
| `onEnd` | `(reason?) => void \| Promise<void>` | No | Cleanup before exit |
| `onChildExit` | `(name, reason) => void \| Promise<void>` | No | Child exited |
| `onUnhandled` | `(msg, sender) => void \| Promise<void>` | No | Unknown message type |
| `handlers` | `Record<MsgType, HandlerFn>` | **Yes** | Named message handlers |
| `methods` | `Record<string, Function>` | No | Custom methods on `this` |
| `hooks` | `ActorHooksConfig` | No | Programmatic hook registration |
| `plugins` | `ActorPlugin[] \| PluginTransform` | No | Plugin chain |

¹ One of `setup` or `initialState` is required. `setup` takes precedence.

### ActorContext (`this` in handlers)

| Member | Type | Description |
|--------|------|-------------|
| `this.state` | `InternalState` | Mutable internal state |
| `this.name` | `string` | Process name |
| `this.id` | `symbol` | Process ID |
| `this.emit(msg)` | `(OutMsg) => void` | Send message to parent |
| `this.agreeToStop()` | `() => void` | Accept STOP request |
| `this.exit(reason)` | `(reason?) => void` | Exit with reason |
| `this.$child[name]` | `AsyncProcess` | Child process lookup |
| `this.fork(fn, name?, args?)` | `(fn, name?, args?) => AsyncProcess` | Spawn a child actor |
| `this.ctx` | `ProcessCtx` | Low-level process context |

### ActorDefinition return value

`defineActor` returns an `ActorDefinition`:

```ts
{
  fn: AsyncProcessFn,              // The compiled generator function
  name?: string,                   // From config.name
  config: ActorConfig,             // Original config (for introspection)
  spawn(args): AsyncProcess,       // Spawn as standalone process
  spawnAsChild(ctx, args, name?): AsyncProcess,  // Spawn as child of ctx
}
```

`ActorDefinition` is plug-compatible with `ProcessFn` — it can be passed to
`ctx.fork()` directly, which unwraps `.fn` automatically.

## Divergences from original proposal

- **`setup()` hook** was not in the original proposal. It replaces the
  `initialState` + `onStart` pattern for async initialization. Added in 0.14.0.
- **`afterStart()` hook** was not in the original proposal. Added for post-yield
  side effects in 0.14.0.
- **`initialState` is now optional** — `setup()` takes precedence when both
  are provided.
- **`onStart` moved before yield** — originally proposed to run after yield.
  Now runs before the first yield (between setup and expose recomputation).
- **Lifecycle order** was not specified in the original proposal. The full
  sequence is: setup → expose → onStart → hooks.onStart → yield → afterStart →
  dispatch → onEnd.
- **ActorDefinition shape**: returns `{ fn, name, config, spawn, spawnAsChild }`
  instead of a merged callable object. `spawn(args)` is flat (not curried
  with `ctx`).
- **Plugin inheritance**: `plugins: (parents) => [...parents, p]` extends
  parent chain; `plugins: [a, b]` replaces it. Fork resolves plugins
  recursively.

---

## Related

- [setup/afterStart hooks](setup-afterstart-hooks.md) — migration guide and backward compatibility
- [Actor plugin system](actor-plugin-system.md)
- [Actor lifecycle hooks](actor-lifecycle-hooks.md)
- [Actor tree naming](actor-tree-naming.md)
- [Actor remote spawning](actor-remote-spawning.md)
- [Docs index](../00-INDEX.md)
