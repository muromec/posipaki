# posipaki: Cascading stop with awaited children, timeout, and a shutdown flag

> **Status**: Implemented.

## Summary

Make actor shutdown cascade to children *and wait for them*. When an actor
stops — it received STOP and `onStopRequested` confirmed via `agreeToStop()`,
or it called `this.exit()` — the framework:

1. sets an internal `shuttingDown` flag,
2. sends STOP to every child,
3. **awaits** each child's generator stopping (`proc.wait()`), bounded by a
   timeout constant,
4. warns (naming the child) for any child that does not stop in time,
5. passes the flag to `onChildExit` so the actor can distinguish a
   shutdown-induced child exit from a spontaneous one,
6. only then emits EXIT to the parent.

This is implemented at the actor level (`defineActor` + the `AsyncProcess`
lifecycle), not in hand-rolled dispatcher loops.

## Motivation

Today the cascade lives in `AsyncProcess.pvtWatchExit`'s `finally`:

```ts
private async *pvtWatchExit(ctx, arg0) {
  try { yield* this.pgenerator(ctx, arg0); }
  finally {
    this.toAllChildren({ type: "STOP" });   // fire-and-forget
    ctx.toParent({ type: "EXIT" });          // immediate — does not wait
  }
}
```

`toAllChildren` just enqueues STOP to each child; nothing waits. The parent
reports EXIT immediately, so a caller that spawns a replacement (or awaits
`proc.wait()`) observes "done" while the children are still tearing down.

**Failure mode (hypothetical):** an actor owns a network-transport child and
exposes a "reload" operation — the supervisor stops the actor and immediately
forks a fresh instance. The old instance's transport child is still tearing
down (flushing its checkpoint, closing its socket) while the replacement's
transport child is already connecting and re-reading the same checkpoint. The
overlap corrupts shared state and multiplies connection churn. Awaiting
children serializes teardown-before-respawn and removes that class of bug.

## Design

### Shutdown flag

`defineActor`'s runtime already closes over `done` / `exitReason`. Add a
boolean `shuttingDown` (initially `false`), set to `true` the moment the actor
enters the stopping phase (STOP + agree, or `exit()`). It is exposed on the
actor context as `this.shuttingDown` and passed to `onChildExit`.

### `onChildExit` signature

```ts
onChildExit?: (
  name: string,
  reason: ExitMessage,
  shuttingDown: boolean,
) => HookResult | Promise<HookResult>;
```

The third argument lets an actor that reacts to a child exit during its own
shutdown (e.g. "my child died — but I'm stopping anyway, so don't respawn it")
distinguish that case from a spontaneous child death.

### Awaiting children: `proc.wait()`, not EXIT

The framework does **not** wait for an `EXIT` message from a child. It awaits
the child's generator stopping, via `proc.wait()`.

The reason: while the parent is processing STOP, all incoming messages to the
parent — including a child's `EXIT` — are queued and not dispatched. So the
await must be on `proc.wait()` (which resolves when the child's generator
completes), not on dispatching an `EXIT`:

```ts
await Promise.race([
  child.wait(),
  sleep(CHILD_STOP_TIMEOUT_MS),
]);
```

### Stopping phase

Instead of `done = true` ending the dispatch loop immediately, STOP becomes a
two-step handshake:

1. `onStopRequested` runs (or the default path fires). `agreeToStop()` (or
   `exit()`) sets `shuttingDown = true` and marks the actor "stopping".
2. The framework sends STOP to all children and records the set of children it
   is awaiting.
3. The framework awaits each child's `proc.wait()` (see above), bounded by the
   timeout.
4. When every child has stopped (or the timeout elapsed), `done = true`, the
   loop exits, and the normal end-of-life sequence resumes (`beforeEnd` →
   `toParent(EXIT)` → `afterEnd`).

### Timeout

A constant bounds the await:

```ts
const CHILD_STOP_TIMEOUT_MS = 1_000;
```

For each child still running when the timeout fires, log a warning naming the
child:

```ts
console.warn(
  `posipaki: child "${name}" did not stop within ${CHILD_STOP_TIMEOUT_MS}ms; continuing shutdown`,
);
```

The actor then emits EXIT regardless.

### Orphaned children (acceptable)

A child may refuse to stop — it never calls `agreeToStop()` and its generator
never completes. After the timeout the parent proceeds anyway and the child is
left running as an **orphan**. This is acceptable and intentional: a stuck
child must not wedge the parent. The warning names the orphan so an operator
can find and reap it.

## Scope

Applies to `defineActor` actors and the `AsyncProcess` lifecycle they use.
Hand-rolled `runDispatch` loops (which handle STOP inline in their reducer)
are explicitly out of scope; they keep their manual teardown until migrated
onto `defineActor`.

## Interaction with `beforeEnd` / `afterEnd`

The awaited cascade slots between `beforeEnd` and EXIT:

```
loop exits
beforeEnd(reason)          ← pre-EXIT teardown
shuttingDown = true; STOP children; await proc.wait() (timeout + warn); onChildExit(..., shuttingDown)
toParent(EXIT)
afterEnd(reason)           ← post-EXIT teardown
```

## Open questions

- Whether the timeout is a single deadline for all children or per-child.
- Whether `onChildExit` fires for cascade children (given EXIT messages are
  queued during STOP processing) or is instead the flag is consulted only via
  `this.shuttingDown`; reconcile with the `proc.wait()` await.
- Should a child that ignores STOP be force-aborted after the timeout, or only
  warned (proposal: warn only; the orphan is acceptable).
