# setup() and afterStart() hooks

## Status
Implemented.

## Summary
Add two new hooks to `ActorConfig`:

- **`setup(args)`** — returns the initial internal state. Replaces the
  `initialState` + `onStart` pattern for actors that need async
  initialization. Runs before the first yield, so `proc.ready()` resolves
  after setup completes.

- **`afterStart()`** — fires after the first yield, before the dispatch
  loop. Use for post-ready side effects.

## Motivation

The `initialState` + `onStart` pattern has a timing issue: `initialState`
returns a placeholder state, `ready()` resolves with the placeholder, then
`onStart` populates the real state asynchronously. Consumers see a
transitional null/empty state at `ready()`. This is visible in email-agent's
`Main` actor which returns `null` from `initialState` and spawns children
in `onStart`.

`setup()` fixes this: the async initialization runs before the first yield,
so `ready()` resolves with the fully-populated state.

## Migration

Before:
```typescript
defineActor({
  initialState: (): State => ({ child: null as unknown as ChildProcess }),
  async onStart(this: Ctx, args: Args) {
    const child = this.fork(ChildActor, "child", {});
    this.state.child = child;
  },
});
```

After:
```typescript
defineActor({
  async setup(this: Ctx, args: Args): Promise<State> {
    const child = this.fork(ChildActor, "child", {});
    return { child };
  },
});
```

### Migration rules
1. `initialState` return value moves into `setup`'s return
2. `onStart` body moves into `setup` (before the return)
3. Remove both `initialState` and `onStart`
4. If no async work is needed, keep `initialState` (still supported)

## Backward compatibility
`initialState` and `onStart` remain fully supported. `setup()` takes
precedence over `initialState` when both are provided.

## Lifecycle order
```
setup(args)       → returns InternalState
expose(state)     → ExposedState
onStart(args)     → legacy, mutates state
hooks.onStart     → legacy
yield exposedState → proc.ready() resolves
afterStart()      → post-ready effects
dispatch loop     → messages
```
