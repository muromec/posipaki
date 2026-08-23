# posipaki: Expose lifecycle states on processes

> **Status**: Idea. Rough concept; no design yet.

## Summary

Give every process a first-class, observable **lifecycle state** describing
where it is in its lifetime, instead of leaving observers to infer it from
`ready()`, `wait()`, `pause()`, and `exit()`.

Proposed states:

| state      | meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `starting` | spawned; before `ready()` resolves (setup/`afterStart` in flight) |
| `running`  | dispatch loop active, **idle** (awaiting the next message)        |
| `busy`     | dispatch loop processing a message (reducer is `await`ing)        |
| `paused`   | messages buffered; not processing                                 |
| `exiting`  | `done` set; teardown running (`beforeEnd` → cascade → `afterEnd`) |
| `exited`   | terminal; generator completed                                     |
| `failed`   | terminal; an error propagated out of the generator                |

## Motivation

Today a process's lifecycle is only observable through scattered primitives:

- `proc.ready()` — "initial state is available" (a point in time, not a state).
- `proc.wait()` — "generator completed" (another point in time).
- `proc.pause()` / `resume()` — buffering, with no exposed indicator.
- `proc.state` — the actor's _domain_ state, orthogonal to lifecycle.
- the tree inspector's `TreeNode.status` — only `"running" | "no introspection"`.

There is no single field that answers "is this process idle, busy, or
shutting down?". Callers that need that answer today have to re-derive it by
wrapping handlers (e.g. the presence protocol: an actor flips its own
`presence: unavailable` before a tool call and `presence: online` after it
settles, because nothing tells the transport whether the process is `busy`).

A first-class state gives every observer — the tree inspector, supervisors,
transports, debug tooling — one primitive to hang off.

## Proposed states

- **`starting`** — from `spawn()`/`start()` until the first state yield and
  `afterStart` complete. `ready()` resolves somewhere inside this window.
- **`running`** — the dispatch loop is at its `yield`, waiting for the next
  message. Nothing is being processed.
- **`busy`** — the dispatch reducer is `await`ing a message handler. This is
  the state that would let a transport derive "presence: busy" for free.
- **`paused`** — `pause()` has been called; messages accumulate in the buffer.
- **`exiting`** — `agreeToStop()`/`exit()` set `done`; the teardown sequence
  (`beforeEnd`, child STOP + await, EXIT, `afterEnd`) is running.
- **`exited`** — terminal; the generator returned.
- **`failed`** — terminal; an uncaught error escaped the generator.

## Transitions

```
starting ──► running ◄──► busy
                │
                ▼
              paused
                │
                ▼
             running ◄─────────────┐
                │                  │
                ▼                  │ (resume)
             exiting ──► exited    │
                │                  │
                ▼                  │
              failed  (terminal)   │
```

(`paused` is entered from and returned to `running`; a `busy` process is
never paused mid-reducer — the pause takes effect at the next yield.)

## API sketch

```ts
type LifecyclePhase =
  | "starting"
  | "running"
  | "busy"
  | "paused"
  | "exiting"
  | "exited"
  | "failed";

// On the process:
proc.phase;                          // readable
proc.subscribe((phase) => { ... });  // reactive, reuses the subscriber mechanism

// In the tree inspector:
TreeNode.status;  // widened to the real phase instead of "running" | "no introspection"
```

## Detection

- `busy` vs `running` is a flag flip inside `runDispatchAsync`: set `busy`
  around `fn(msg)`, back to `running` when the reducer returns.
- `starting` is "before the first yield"; `exiting` is `done === true`.
- `paused` is already tracked internally (`pvtIsPaused`) — just exposed.

## Open questions

- **Naming:** `phase` (matches `SupervisorState.phase`) or `status` (matches
  `TreeNode.status`)? Pick one and align the other.
- **`starting` boundary:** does it end at `ready()` or at `afterStart`
  completion? The latter is more useful to callers that fork in `setup`.
- **`busy` overhead:** is a boolean flip per dispatched message acceptable?
  (Almost certainly yes — it's one store.)
- **Is `paused` orthogonal?** A process is paused _while_ running, not instead
  of running. Worth deciding whether `paused` is a phase or a separate
  boolean flag.
- **Presence:** should the transport derive presence from `busy`/`running`
  instead of the actor emitting `presence` messages? This would invert the
  current "actor owns presence" design.
- **Reactive vs polled:** is `subscribe` enough, or do callers also need the
  current value synchronously via `proc.phase` (sketched: both)?
