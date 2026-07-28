# posipaki: Actor Lifecycle Hooks

> **Status**: Draft proposal. No code written yet.

## Summary

Extend `ProcessCtx` and `defineActor`'s config with **lifecycle hooks** —
named functions that fire at specific points in an actor's lifetime.
Hooks are an extension of the core API, available to any actor regardless
of whether plugins are used.

```ts
// Direct hook registration in processCtx (low-level API):
async function* myActor(ctx: ProcessCtx<...>) {
  ctx.onStart(async (state) => { ... });
  ctx.onMessage(async (msg, sender) => { ... });
  ctx.onEmit(async (msg) => { ... });
  yield* runDispatchAsync(...);
}

// Declarative hooks in defineActor (high-level API):
const MyActor = defineActor({
  hooks: {
    onStart(state)     { this.log.info('started'); },
    onMessage(msg)     { this.log.debug(`← ${msg.type}`); },
    onEmit(msg)        { this.log.debug(`→ ${msg.type}`); },
    onChildExit(name)  { this.log.debug(`child ${name} gone`); },
    onError(err)       { this.log.error(err); },
  },
  handlers: { ... },
});
```

Every hook is optional.  Every hook has access to `this` (the actor
context: `this.state`, `this.log`, `this.emit`, `this.fork`, …).

## Motivation

The current `defineActor` already has lifecycle methods: `onStart(args)`,
`onStopRequested()`, `onEnd(reason)`, `onChildExit(name, msg)`.  But these
are **actor methods** — they run one implementation per actor.  There's no
way to register **multiple** callbacks for the same lifecycle event, and no
way to hook into the **message dispatch path** (`onMessage` / `onEmit`).

This makes cross-cutting concerns awkward:

- **Logging**: every actor manually creates a logger in `initialState` and
  calls `this.state.log.debug(...)` in every handler.  There's no "log every
  message" fire-and-forget.
- **RBAC**: gating tool access requires checking permissions inside each
  handler.  There's no "check before dispatch" hook.
- **Rate limiting**: counting calls requires wrapping every handler.
- **Child visibility**: when a child forks a grandchild, the root actor has
  no way to observe the grandchild's lifecycle.

Hooks solve this by giving actors **multiple hookable points** in the
lifecycle — each supporting multiple registered callbacks — without
requiring a plugin system.

## Design principles

1. **Hooks are additive.**  Multiple callbacks can register for the same
   hook (e.g. two `onMessage` callbacks).  They fire in registration order.
2. **Hooks are opt-in.**  An actor with no hooks runs exactly as before.
   Zero overhead, zero API changes for existing code.
3. **Hooks live on `ProcessCtx` (low-level) and on `defineActor` config
   (high-level).**  The same mechanism serves both APIs.
4. **`onMessage` can short-circuit.**  A hook can return `stopPropagation()`
   to prevent subsequent hooks AND the named handler from running.
5. **What a hook can do must also be possible in `onStart`/`initialState`.**
   Hooks are sugar, not a separate capability set.  An actor that doesn't
   use hooks can achieve the same effect by wrapping its handlers.

## API

### Low-level: ProcessCtx extensions

`ProcessCtx` gains hook registration methods:

```ts
type ProcessCtx<Args, State, IM extends Message, OM extends Message> = {
  // ... existing fields ...

  // ── hooks ──────────────────────────────────────────────────────────

  onStart(fn: (state: State) => void | Promise<void>): void;
  onMessage(fn: (msg: IM, sender: SenderInfo) => HookResult): void;
  onEmit(fn: (msg: OM) => void): void;
  onChildExit(fn: (name: string) => void | Promise<void>): void;
  onStopRequested(fn: () => void | Promise<void>): void;
  onEnd(fn: (reason: unknown) => void | Promise<void>): void;
  onError(fn: (err: unknown) => void): void;
};
```

Usage from a raw async generator:

```ts
async function* myActor(ctx: ProcessCtx<Args, State, MyIn, MyOut>, args: Args) {
  const state = { counter: 0 };
  yield state;

  ctx.onMessage(async (msg, sender) => {
    console.log(`← ${msg.type} from ${sender.fromName}`);
  });

  ctx.onEmit((msg) => {
    console.log(`→ ${msg.type}`);
  });

  ctx.onError((err) => {
    console.error('actor error:', err);
  });

  yield* runDispatchAsync(ctx.pname, async (stamped) => {
    const [msg, sender] = stamped;
    // ... dispatch ...
  }, () => done);
}
```

### High-level: defineActor hooks config

`defineActor`'s config gains an optional `hooks` field:

```ts
type ActorConfig<..., State, InMsg, OutMsg> = {
  // ... existing fields ...
  hooks?: {
    onStart?:       (this: ActorContext<...>, state: State) => void | Promise<void>;
    onMessage?:     (this: ActorContext<...>, msg: InMsg, sender: SenderInfo) => HookResult;
    onEmit?:        (this: ActorContext<...>, msg: OutMsg) => void;
    onChildExit?:   (this: ActorContext<...>, name: string) => void | Promise<void>;
    onStopRequested?:(this: ActorContext<...>) => void | Promise<void>;
    onEnd?:         (this: ActorContext<...>, reason: unknown) => void | Promise<void>;
    onError?:       (this: ActorContext<...>, err: unknown) => void;
  };
};
```

Key: each hook receives `this` bound to the actor context — `this.state`,
`this.log`, `this.emit`, `this.fork`, etc. are all available.

Note: the existing `onStart(args)` method signature stays unchanged (it
receives `args`, not `state`).  The `hooks.onStart(state)` is a separate
thing — it fires *after* the actor's `onStart(args)` method and the initial
state yield, giving hooks access to the fully initialized state.

### stopPropagation

```ts
/** Sentinel returned by onMessage hooks to stop further dispatch.
 *  Prevents subsequent hooks AND the named handler from running. */
export const STOP_SENTINEL = Symbol('posipaki.stopPropagation');

/** Return this from an onMessage hook to short-circuit dispatch. */
export const stopPropagation = (): typeof STOP_SENTINEL => STOP_SENTINEL;

type HookResult = void | typeof STOP_SENTINEL;
```

Usage:

```ts
hooks: {
  onMessage(msg) {
    if (msg.type === 'FORBIDDEN') return stopPropagation();
    // normal dispatch continues
  },
}
```

Why a return-value sentinel and not a ctx flag:

- **Explicit**: you MUST `return stopPropagation()`.  No silent failures
  from forgetting to call `ctx.stopPropagation()`.
- **No ctx mutation**: the sentinel is a value, not a state change.
  No risk of one hook's stop leaking into another.
- **Async-safe**: dispatch loop `await`s the hook, checks the resolved
  value.  Works identically for sync and async hooks.
- **Zero cost**: one object-identity check (`=== STOP_SENTINEL`) after
  each hook.

## Hook execution order (per message)

For an incoming `POKE` message:

```
1. hooks.onMessage[0](msg, sender)
2. hooks.onMessage[1](msg, sender)      ← if [0] returned stopPropagation(), skip
   ...
N. built-in STOP/EXIT interception
N+1. handlers.POKE(msg, sender)         ← if any hook returned stopPropagation(), skip
N+2. onUnhandled (if no handler matched)
```

For `this.emit(msg)`:

```
1. hooks.onEmit[0](msg)
2. hooks.onEmit[1](msg)
   ...
N. ctx.toParent(msg)                    ← actual emit
```

## Namespaced process names (tree naming)

When an actor forks a child, the child's name is automatically prefixed:

```ts
// In actor "openai":
ctx.fork(connector, 'pool');     // child name: "openai:pool"
// In pool:
ctx.fork(toolCaller, 'tools');   // grandchild name: "openai:pool:tools"
```

The prefix is joined with `:`.  This is automatic — no manual naming.
The root actor (spawned, not forked) has its name set explicitly at
spawn time.

Implementation: `AsyncProcess.fork()` detects the parent's `pname` and
builds `${parentName}:${childName}`.  The low-level `spawnAsync()` still
accepts an absolute name, preserving backward compatibility.

## Error contract

If an `onMessage` or `onEmit` hook throws:

1. The error is caught.
2. `onError` hooks fire (with the error).
3. The dispatch loop exits.
4. `onEnd` fires (with the error as the reason).
5. The generator returns → `_watchExit` sends STOP to children, EXIT to parent.

If an `onError` hook itself throws: the error is logged to `console.error`
and the actor exits (no infinite loop).

## Migration

All existing `defineActor` uses continue unchanged:

- `onStart(args)` method → unchanged (fires before `hooks.onStart`)
- `onStopRequested()` method → unchanged (fires before `hooks.onStopRequested`)
- `onEnd(reason)` method → unchanged (fires before `hooks.onEnd`)
- `onChildExit(name)` method → unchanged (fires before `hooks.onChildExit`)

New hooks are **additive**.  An actor that adds `hooks.onMessage` for
logging doesn't need to change anything else.

## Checklist

- [ ] Types: `HookResult`, `stopPropagation`, `STOP_SENTINEL`
- [ ] `ProcessCtx` gains `onStart`, `onMessage`, `onEmit`, `onChildExit`,
      `onStopRequested`, `onEnd`, `onError`
- [ ] `AsyncProcess.fork` builds prefixed child names (`parent:child`)
- [ ] `defineActor` config accepts optional `hooks` field
- [ ] Hook registration works for both low-level (`ctx.onMessage(...)`)
      and high-level (`hooks: { onMessage(...) }`) paths
- [ ] `onMessage` short-circuit with `stopPropagation()`
- [ ] Error in hook → `onError` → `onEnd` → clean exit
- [ ] Tests: hook execution order (multiple callbacks)
- [ ] Tests: `stopPropagation()` from hook 1 skips hook 2 and handler
- [ ] Tests: hook error triggers `onError` and clean shutdown
- [ ] Tests: tree naming (`parent:child:grandchild`)
- [ ] Tests: existing actors without hooks still pass
- [ ] Update `src/index.ts` exports
- [ ] Bump minor version
