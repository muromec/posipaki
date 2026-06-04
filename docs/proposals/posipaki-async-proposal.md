# posipaki async generator support — implemented ✅

> **Status**: Implemented. This document captures the original proposal,
> what was actually built, and how each open question was resolved.

## Motivation

posipaki process functions were originally synchronous generators:

```ts
type ProcessGenerator<State, InMessage> = Generator<State | null, void, InMessage>;
```

This forced all work inside `runDispatch` reducers to be synchronous. Any I/O —
API calls, database queries, AI inference, timers — had to be kicked off as a
side-effect via `setTimeout` or `ctx.toParent()`, with no way to sequence
results naturally:

```ts
// BEFORE — awkward and order-dependent
yield* runDispatch("agent", (msg) => {
  if (msg.body === "wait") {
    setTimeout(() => {
      ctx.toParent({ type: "REPLY", body: `Echo: ${msg.body}` });
    }, 1000);
  } else {
    ctx.toParent({ type: "REPLY", body: `Echo: ${msg.body}` });
  }
});
```

Two replies to the same message type, split across a synchronous path and a
`setTimeout` callback. Testing this was fragile; debugging was worse. If the
process exited before the timer fired, the reply was lost silently.

## What was built

Rather than modifying the existing `Process` class (which would risk breaking
sync-only users), async support was added as a **parallel class** —
`AsyncProcess` — alongside new types, helpers, and a bridge function.

### New type alias (`src/types.ts`)

```ts
export type AsyncProcessFn<
  Args,
  State,
  InMessage extends Message,
  OutMessage extends Message,
> = (
  ctx: ProcessCtx<Args, State, InMessage, OutMessage>,
  args: Args,
) => AsyncGenerator<State | null, void, InMessage>;
```

### `runDispatchAsync` (`src/process.async.ts`)

An async equivalent of `runDispatch`. The only structural difference is
`await fn(msg)` instead of `fn(msg)`:

```ts
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
```

### `AsyncProcess` class (`src/process.async.ts`)

A full `Process`-equivalent built around `AsyncGenerator`. Key differences
from `Process`:

| Aspect | `Process` (sync) | `AsyncProcess` |
|---|---|---|
| Generator type | `Generator<S, void, IM>` | `AsyncGenerator<S, void, IM>` |
| Tick execution | Synchronous `_tick(): void` | `async _tick(): Promise<void>` with `#tickInProgress` guard |
| `watchExit` | Shared utility in `util.ts` | Private `async *_watchExit` method on the class |
| `send()` | Enqueues + schedules microtask | Same, but tick is `await`-based |
| `wait()` | Resolves on generator completion | Returns `Promise<void>` that also rejects on unhandled reducer errors |

### `asyncify` bridge (`src/adapters.ts`)

Wraps any sync `ProcessFn` into an `AsyncProcessFn`, so sync process functions
can be forked from async processes via `forkSync`:

```ts
export function asyncify<A, S, IM extends Message, OM extends Message>(
  fn: ProcessFn<A, S, IM, OM>,
): AsyncProcessFn<A, S, IM, OM> {
  return async function* (ctx, args) {
    yield* fn(ctx, args) as any
  }
}
```

This is used internally by `AsyncProcess.forkSync()`.

### `spawnAsync` entry point

```ts
export function spawnAsync<Args, State, InMessage, OutMessage>(
  fn: AsyncProcessFn<Args, State, InMessage, OutMessage>,
  pname: string,
  toParent?: ProcessMessageCb<OutMessage>,
): (args: Args) => AsyncProcess<Args, State, InMessage, OutMessage>
```

### Public API surface (`src/index.ts`)

```ts
export { Process, spawn, runDispatch }           // sync — unchanged
export { AsyncProcess, spawnAsync, runDispatchAsync, asyncify }
export type { AsyncProcessFn, ... }
```

## Resolution of open questions

### 1. Back-pressure

> If the reducer takes 30 seconds but 5 more messages arrive in the buffer,
> should the next tick process all of them or just one?

**Resolved**: `_tick` drains the entire buffer in a `while` loop, processing
messages **serially** within a single tick (same as the sync `Process`). When
the reducer contains `await`, each message waits for the previous one's
promise to settle before `.next()` is called with the next buffered message.
This is documented in the `AsyncProcess` class JSDoc: *"Messages are processed
one at a time — if a tick is already in-flight, new messages are buffered and
processed when the current tick completes."*

### 2. `_scheduleTick` concurrency (`#tickInProgress` guard)

> If an async tick is already in-flight and a new message arrives, a second
> tick would try to call `.next()` on a generator that's already mid-`await`.

**Resolved**: Added a `#tickInProgress` boolean flag. `_tick()` returns
immediately (no-op) if a tick is already running:

```ts
protected async _tick(): Promise<void> {
  if (!this.current || this._tickInProgress) return;

  this._tickInProgress = true;
  try {
    // ... drain buffer ...
  } finally {
    this._tickInProgress = false;
  }
}
```

This is verified by the test *"should never allow concurrent ticks on the same
generator"* in `process.async.test.ts`.

### 3. Should `ProcessFn` become a union type?

> So that `spawn()` accepts both sync and async process functions without the
> author having to pick `AsyncProcessFn` explicitly.

**Resolved**: Kept separate types. `spawnAsync` accepts `AsyncProcessFn`, and
`asyncify` bridges sync → async. `forkSync` on `AsyncProcess` accepts
`ProcessFn` directly and calls `asyncify` internally. The types stay
unambiguous — no union type needed.

### 4. Does `watchExit` need changes?

> It wraps `process.pgenerator(ctx, arg0)` in a generator — for async
> processes this would need an async generator wrapper.

**Resolved**: The shared `watchExit` utility in `util.ts` was left unchanged.
`AsyncProcess` has its own private `async *_watchExit` method that does the
same job (STOP to children, EXIT to parent in a `finally` block) but for async
generators. No separate public `watchExitAsync` was created.

## Non-goals (still true)

- Changing the sync API in any way
- Supporting `AsyncGenerator` in `pipe` or `supervisor`
- Adding reactive / observable patterns on top
- Changing the message type system