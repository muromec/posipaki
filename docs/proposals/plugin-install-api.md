# Plugin Install API — structured context

**Status:** draft

## Summary

Replace the monkey-patched `ProcessCtx` passed to `ActorPlugin.install()` with
the actor's own `ActorContext` (`self`). Group the registration methods
(`onMessage`, `onEmit`, `decorate`, `registerReflection`, etc.) into structured
namespaces on `ActorContext`: `self.hooks`, `self.reflection`, `self.decorate`.

## Motivation

Currently `install()` receives a `ProcessCtx` that gets monkey-patched at
runtime with nine extra methods:

```ts
// define-actor.ts — before install()
ctxAny.onMessage = ...
ctxAny.onEmit = ...
ctxAny.onChildExit = ...
ctxAny.onStart = ...
ctxAny.onStopRequested = ...
ctxAny.onError = ...
ctxAny.onEnd = ...
ctxAny.decorate = ...
ctxAny.registerReflection = ...
```

The `ActorPlugin` type says `install(ctx: ProcessCtx<...>)` but the runtime
object is `ProcessCtx & { onMessage, onEmit, ..., decorate, registerReflection }`.
The type is lying.

This causes real problems:

- **`registerReflection`'s callback `this` type**: the callback receives
  `ActorContext` as `this`, but `ProcessCtx` lives in `types.ts` which cannot
  import `ActorContext` from `actor-types.ts` (circular). The type can never be
  honest about what `this` is.

- **Nine optional `?` markers on `ProcessCtx`**: `onMessage?`, `onEmit?`, etc.
  are typed as optional but always present at `install()` time.

- **`ctx` has no semantic structure**: nine unrelated methods flat on one
  object. Plugin authors need `ctx: any` to use them.

`ActorContext` already wraps `ProcessCtx` (via `self.ctx`). Giving plugins the
full `ActorContext` instead of a decorated `ProcessCtx` eliminates the anonymous
third type entirely.

## Design

### Structured namespaces on ActorContext

```ts
export type ActorContext<...> = Methods & ActorDecorated & {
  state: InternalState;
  name: string;
  id: symbol;

  emit: (msg: OutMsg) => void;
  agreeToStop: () => void;
  exit: (reason?: unknown) => void;
  $child: Record<string, AsyncProcess<...>>;
  fork(...): AsyncProcess<...>;

  /** Raw process context — pname, sendSelf, toParent, etc. */
  ctx: ProcessCtx<Args, InternalState, InMsg, OutMsg>;

  /** Hook registration. */
  hooks: {
    onMessage: (h: OnMessageHook<InMsg>) => void;
    onEmit: (h: OnEmitHook<OutMsg>) => void;
    onChildExit: (h: OnChildExitHook) => void;
    onStart: (h: OnStartHook<ExposedState>) => void;
    onStopRequested: (h: OnStopRequestedHook) => void;
    onError: (h: OnErrorHook) => void;
    onEnd: (h: OnEndHook) => void;
  };

  /** Reflection method registration (plugin namespace implicit). */
  reflection: {
    register(name: string, method: (this: ActorContext<unknown, unknown, Message, Message, {}, {}>) => unknown): void;
  };

  /** Property decoration. */
  decorate: (key: string, value: unknown) => void;
};
```

### Plugin interface

```ts
export interface ActorPlugin<
  InMsg extends Message = Message,
  OutMsg extends Message = Message,
  State = unknown,
> {
  name: string;
  install(self: ActorContext<unknown, State, InMsg, OutMsg, {}, {}>): void | Promise<void>;
}
```

### Plugin usage (before/after)

```ts
// Before — monkey-patched ProcessCtx
const myPlugin: ActorPlugin = {
  name: 'myPlugin',
  install(ctx: any) {
    ctx.onMessage?.((msg) => { ... });
    ctx.decorate?.('label', 'hello');
    ctx.registerMethod?.('ping', () => 'pong');
  },
};

// After — structured ActorContext
const myPlugin: ActorPlugin = {
  name: 'myPlugin',
  install(self) {
    self.hooks.onMessage((msg) => { ... });
    self.decorate('label', 'hello');
    self.reflection.register('ping', function () { return 'pong'; });
  },
};
```

No `?:`, no `any`, no monkey-patching.

### What comes off ProcessCtx

All the optional hook registration methods (`onMessage?`, `onEmit?`, etc.),
`decorate?`, and `registerReflection?` are removed from `ProcessCtx` in
`types.ts`. `ProcessCtx` goes back to being a pure transport:

```ts
export type ProcessCtx<Args, State, IM, OM> = {
  pname: string;
  id: symbol;
  parentName: string | null;
  parentId: symbol | null;
  sendSelf: (msg: IM | StopMessage) => void;
  toParent: ProcessMessageCb<OM>;
} & Pick<AsyncProcess<Args, State, IM, OM>, "fork" | "forkSync">;
```

### Reflection callback `this` type

Because `reflection.register` is defined on `ActorContext` in `actor-types.ts`,
the callback's `this` can be typed as `ActorContext` directly — no circular
dependency, no structural duplication:

```ts
reflection: {
  register(name: string, method: (this: ActorContext<unknown, unknown, Message, Message, {}, {}>) => unknown): void;
}
```

The plugin callback gets full access to `this.state`, `this.name`, `this.$child`,
`this.emit()`, `this.agreeToStop()`, `this.ctx` — everything the actor has.

## Implementation plan

1. Add `hooks`, `reflection`, `decorate` to `ActorContext` type in `actor-types.ts`
2. In `define-actor.ts`: build `self.hooks`, `self.reflection`, `self.decorate` instead of monkey-patching `ctx`
3. Pass `self` to `p.install()` instead of `ctx`
4. Update `ActorPlugin.install()` signature in `hooks.ts`
5. Update all existing plugin tests (remove `?:`, change `ctx.onMessage?.()` → `self.hooks.onMessage()`)
6. Remove optional hook methods from `ProcessCtx` type in `types.ts`
7. Remove `ReflectionMethodCtx` — no longer needed
8. Wire `currentPluginName` into `self.reflection.register`

## Impact

- **Breaking change** to `ActorPlugin.install()` signature
- Existing plugins switch from `ctx: any` to typed `self`
- `ProcessCtx` becomes cleaner (drops 9 optional properties)
- `ReflectionMethodCtx` is deleted
- No circular dependency issues

## Related

- [Actor Reflection RPC](actor-reflection-rpc.md) — the reflection mechanism this enables
- [Tree Introspection Plugin](tree-introspection-plugin.md) — first consumer of `self.reflection.register()`
- [Actor Plugin System](actor-plugin-system.md)

## Lifecycle position

Plugins install during the **augment** phase, before `setup()` generates
the actor's initial state. See [defineActor lifecycle](define-actor-proposal.md#lifecycle-order)
for the full phase ordering.

This means plugins have access to `self` (ActorContext) but `this.state`
is not yet populated — state setup hasn't run. Plugins should register
hooks and reflection methods, not inspect state.
