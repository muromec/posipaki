# posipaki async generator support — proposal

## Motivation

posipaki process functions are currently synchronous generators:

```ts
type ProcessGenerator<State, InMessage> = Generator<State | null, void, InMessage>;
```

This forces all work inside `runDispatch` reducers to be synchronous. Any I/O — API calls, database queries, AI inference, timers — must be kicked off as a side-effect via `setTimeout` or `ctx.toParent()`, with no way to sequence results naturally. The agent loop from demonstrates the pain:

```ts
// CURRENT — awkward and order-dependent
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

Two replies to the same message type, split across a synchronous path and a `setTimeout` callback. Testing this is fragile; debugging is worse. If the process exits before the timer fires, the reply is lost silently.

The proposal: support `AsyncGenerator` alongside `Generator` so process functions can use `await` for I/O, timers, and other async work while retaining the message-driven actor model.

## Proposal

Add a single new type alias and make the `Process` class handle both sync and async generators.

### New type alias

```ts
type AsyncProcessGenerator<ProcessState, InMessage> = AsyncGenerator<
  ProcessState | null,
  void,
  InMessage
>;
```

### ProcessFn overload (or union type)

Process functions that return an `AsyncGenerator` declare so explicitly. The existing `ProcessFn` for sync generators remains unchanged:

```ts
// unchanged — sync process
export type ProcessFn<Args, State, InMessage, OutMessage> = (
  ctx: ProcessCtx<InMessage, OutMessage>,
  args: Args,
) => Generator<State | null, void, InMessage>;

// new — async process
export type AsyncProcessFn<Args, State, InMessage, OutMessage> = (
  ctx: ProcessCtx<InMessage, OutMessage>,
  args: Args,
) => AsyncGenerator<State | null, void, InMessage>;
```

### `runDispatch` becomes async-aware

A new `runDispatchAsync` helper (or an overload) that works with async reducers:

```ts
async function* runDispatchAsync<M>(
  name: string,
  fn: (msg: M) => Promise<void>,
  readyFn: () => boolean = () => false,
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

The only difference from the current `runDispatch` is `await fn(msg)` instead of `fn(msg)`.

### `Process._tick` becomes `async _tick`

The internal message processing loop needs to `await` each step when the generator is async. A runtime check (`Symbol.asyncIterator` or `instanceof`) distinguishes sync from async generators.

```ts
async _tick() {
  if (!this.current) return;
  let msg: InMessage | undefined;
  while ((msg = this.buffer.shift())) {
    const ret = await this.current.next(msg);
    if (ret.done) break;
  }
  this.notify();
  this._eatResult(ret);
}
```

The `await` on `next()` is a no-op for sync generators (they return `IteratorResult`, not `Promise<IteratorResult>`, but `await` on a non-Promise value returns it immediately).

### Minimal API surface change

| What | Before | After |
|---|---|---|
| `ProcessFn` return type | `Generator<S, void, IM>` | unchanged |
| New: `AsyncProcessFn` | — | `AsyncGenerator<S, void, IM>` |
| `runDispatch` | sync reducer | unchanged |
| New: `runDispatchAsync` | — | async reducer, `await fn(msg)` |
| `Process._tick` | `_tick(): void` | `async _tick(): Promise<void>` |
| `spawn()` signature | unchanged | unchanged |

All existing sync code continues to work. Async is opt-in: use `AsyncProcessFn` + `runDispatchAsync`.

## Usage

The agent loop from rewritten:

```ts
import { runDispatchAsync } from "posipaki";
import type { AsyncProcessFn } from "posipaki";

const agentLoop: AsyncProcessFn<...> = async function* (ctx, _args) {
  const state = { done: false };
  yield state;

  yield* runDispatchAsync("agent", async (msg) => {
    if (msg.type === "MESSAGE") {
      if (msg.body === "wait") {
        await new Promise((r) => setTimeout(r, 1000));
      }
      const reply = await runAgent(msg); // real AI call
      ctx.toParent({ type: "REPLY", body: reply });
    }
  });
};
```

All paths through the reducer use `await` naturally. Ordering is guaranteed by the `yield` / `await` chain. If the agent call fails, the error propagates to the caller and can be caught.

## Open questions

1. **Back-pressure**: If the reducer takes 30 seconds but 5 more messages arrive in the buffer, should the next tick process all of them or just one? The current sync `_tick` drains the entire buffer in a `while` loop. For async reducers, this means messages are processed serially within a single tick — which is probably correct but worth documenting.

2. **`_scheduleTick` concurrency**: Currently `_scheduleTick` uses `defer` (microtask). If an async tick is already in-flight and a new message arrives, a new tick is scheduled. The second tick would try to call `.next()` on a generator that's already mid-`await`. This needs a guard — skip scheduling if a tick is already running (`#tickInProgress` flag).

3. **Should `ProcessFn` become a union type?** So that `spawn()` accepts both sync and async process functions without the author having to pick `AsyncProcessFn` explicitly. This is ergonomic but makes the type signature harder to read. Starting with separate types is safer.

4. **Does `watchExit` need changes?** It wraps `process.pgenerator(ctx, arg0)` in a generator — for async processes this would need to be an async generator wrapper. Probably a separate `watchExitAsync`.

## Non-goals (for this proposal)

- Changing the sync API in any way
- Supporting `AsyncGenerator` in `pipe` or `supervisor` (those can follow later)
- Adding reactive / observable patterns on top
- Changing the message type system
