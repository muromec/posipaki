# posipaki: `defineActor` — high-level actor wrapper

> **Status**: Implemented (0.14.0+).

## Summary

`defineActor` is a declarative wrapper around the existing `runDispatch` /
`AsyncProcess` primitives.  It keeps the low-level generator API unchanged
and adds a higher layer that every real actor benefits from:

- Named message handlers instead of `if/switch` chains
- Automatic `fromName` / `fromId` stamping on every outbound message
- Lifecycle hooks: `setup`, `afterStart`, `onStopRequested`, `onEnd`,
  `onChildExit`, `onUnhandled`
- **Built-in STOP and EXIT handling** — STOP calls `onStopRequested` (actor
  can accept or defer); EXIT from children is intercepted automatically
- Dynamic child management with `this.fork()` and `this.$child[name]`
- **Plugin system** — hooks, reflection methods, and decorators composed via
  `mergeConfigs` with Fastify-style type augmentation

The existing `spawn`, `spawnAsync`, `runDispatch`, `runDispatchAsync`, and
`Process` / `AsyncProcess` classes remain untouched.  `defineActor` compiles
down to those primitives — it is purely a convenience layer.

## Lifecycle order

The full lifecycle of a `defineActor` actor, in order:

### 1. define — `defineActor(config)`

Returns an `ActorDefinition`. Nothing runs yet — pure declaration.

### 2. augment — plugins install

```
for (const p of plugins) { config = await p(config); }
```

Each plugin is a function `(config) => config` that composes hooks, reflection
methods, and decorators into config via `mergeConfigs`. Sync and async plugins
are all `await`ed together so the generator doesn't yield between installs.

Plugins receive the raw config object — no `ActorContext`, no `self`, no
monkey-patched `ProcessCtx`. They compose declaratively into config keys:

| Config key | Purpose |
|---|---|
| `onMessage`, `onEmit`, `onChildExit`, `onError`, `onEnd`, `onStopRequested` | Hook functions, chained via `chainHook` |
| `afterStart`, `afterStopRequested`, etc. | Post-hooks (same pattern) |
| `$reflectionMethods` | Reflection methods (e.g. `inspect.getTree`) — auto-merged |
| `$decorate` | Property decoration (e.g. `this.log`) — wired at spawn |
| `methods` | Custom methods on `this` |

Type augmentation: plugins use `declare module "../hooks"` to extend
`ActorDecorated` (for `this.*` methods) and `ActorReflection` (for
`proc.$reflection` types).

### 3. assemble — reflection wired

```
attachReflection(proc);
```

All `$reflectionMethods` from config and plugins are wired onto
`proc.$reflection`. Runs once after all plugins have installed,
before the actor generates its initial state.

### 4. start — generate state

```
setup(args)       → returns InternalState (async)
```

`setup()` is the single entry point for state initialization. It receives
the spawn arguments and returns the initial `InternalState` (or a
`Promise<InternalState>`). It runs before the first yield, so `proc.ready()`
resolves with fully-populated state.

### 5. ready

```
yield internalState → proc.ready() resolves — external consumers see state
```

### 6. post-ready

```
afterStart()      → post-ready side effects (async, runs after consumers can observe state)
```

### 7. run

```
dispatch loop     → message handlers fire on incoming messages
```

### 8. cleanup

```
onEnd(reason)     → cleanup, fires before process exit
```

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

## API reference

### Quick example

```ts
import { defineActor } from "posipaki";

const pool = defineActor<PoolArgs, PoolState, PoolInMessage, PoolOutMessage>({
  async setup(args) {
    for (let i = 0; i < args.size; i++) {
      this.fork(args.workerFn, `w${i}`, args.workerArgs);
    }
    return { free: args.size, queued: 0 };
  },

  handlers: {
    USER_MESSAGE(msg) {
      this.state.queued++;
    },
  },

  onUnhandled(msg) {
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
| `setup` | `(args) => InternalState \| Promise<InternalState>` | Yes | Async state init before first yield |
| `name` | `string` | No | Preferred process name |
| `afterStart` | `() => void \| Promise<void>` | No | Post-yield side effects |
| `onStopRequested` | `() => void \| Promise<void>` | No | STOP decision point |
| `onEnd` | `(reason?) => void \| Promise<void>` | No | Cleanup before exit |
| `onChildExit` | `(name, reason) => void \| Promise<void>` | No | Child exited |
| `onUnhandled` | `(msg, sender) => void \| Promise<void>` | No | Unknown message type |
| `handlers` | `Record<MsgType, HandlerFn>` | **Yes** | Named message handlers |
| `methods` | `Record<string, Function>` | No | Custom methods on `this` |
| `plugins` | `ActorPlugin[] \| PluginTransform` | No | Plugin chain |

### ActorContext (`this` in handlers and hooks)

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

---

## Related

- [Plugin install API](plugin-install-api.md) — plugin authoring guide
- [Actor plugin system](actor-plugin-system.md)
- [Actor lifecycle hooks](actor-lifecycle-hooks.md)
- [Actor tree naming](actor-tree-naming.md)
- [Actor remote spawning](actor-remote-spawning.md)
- [Docs index](../00-INDEX.md)

## Spawn API (design in progress, 2026-08-11)

Three entry points for spawning an actor.  Currently have overlapping but
inconsistent signatures.  Target: unify opts shapes and fold positional params.

### Current state

```ts
// Standalone — no parent
Actor.spawn(args, opts?: { name?, toParent? })

// Child from within actor context
this.fork(Actor, args?, opts?: { name? })

// Child from outside actor context
Actor.spawnAsChild(ctx, args, opts?: { name? }, parentPlugins?: ActorPlugin[])
```

Issues:

1. **`spawnAsChild` takes `AnyProcessCtx`** (`ProcessCtx<unknown, unknown, Message, Message>`)
   but callers have concrete `ProcessCtx<Args, State, IM, OM>`.  Assignment fails
   because `ProcessCtx` is invariant in its type params.  Every external call site
   needs `ctx as any`.

2. **4th positional param `parentPlugins`** on `spawnAsChild` is only used by
   `self.fork()` internally.  External callers never pass it.  It should be in opts.

3. **`this.fork()` vs `this.ctx.fork()`** — two ways to fork.  The decorated one
   (`this.fork()`) does tree-naming + plugin propagation + `$child` tracking.
   The raw one (`this.ctx.fork()`) is used only by the tool pool (which doesn't
   need plugins).  Naming is confusing.

### Target

```ts
// Standalone
Actor.spawn(args, opts?: {
  name?: string;
  toParent?: (msg) => void;
  appendPlugins?: ActorPlugin[];
})

// Child from within actor context — tree-named, plugin-aware, $child-tracked
this.fork(Actor, args?, opts?: {
  name?: string;
  appendPlugins?: ActorPlugin[];
})

// Child from outside — thin wrapper, same opts shape
Actor.spawnAsChild(ctx, args, opts?: {
  name?: string;
  appendPlugins?: ActorPlugin[];
})
```

Changes:

- `appendPlugins` added to all three opts (enables test utilities as plugins)
- `parentPlugins` (4th positional) folded into opts → `appendPlugins`
- `spawnAsChild` ctx type broadened to accept concrete `ProcessCtx` (fixes `as any`)
- All three share the same opts shape (minus `toParent` which is spawn-only)
