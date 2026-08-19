# posipaki: forceStop — hard-kill a process

> **Status**: Implemented (2026-08-19).

## Summary

Add `AsyncProcess.forceStop()` — a hard kill that terminates a process
immediately, *without* a STOP message, *without* running the generator's
`finally` (so no EXIT, no STOP cascade), leaving nothing to observe.

## Motivation

STOP is graceful: the generator cooperates, emits EXIT, and the parent observes
the child's death via the normal message flow. The orphan-policy needs a way to
kill a process that should simply go away — where there is nothing to observe
afterward and the caller does not care how it died.

## Design

`forceStop()`:

1. marks the process dead (a `pvtDead` flag guards `send`/`pvtScheduleTick`),
2. abandons the generator (`current = null`) so its `finally` never runs,
3. drops the inbox and stops scheduling,
4. releases incoming observers and drains outgoing subscriptions
   (`adopt`/`monitor` unsubscribes),
5. settles `wait()` and `ready()`.

There is **no EXIT** and **no cascade**. The caller removes the process from its
`children`/`orphans` list imperatively — exactly one place owns that list
mutation, matching "ownership where state lives".

Applies to children and orphans alike; it is a per-process primitive, not tied
to `defineActor`.

### Best-effort caveat

JS offers no way to cancel a pending promise. An *idle* generator (suspended at
`yield`) is abandoned cleanly — its `finally` never runs. A generator mid-`await`
will complete its `finally` when that `await` settles, because the pending
promise still holds the continuation. `forceStop()` is therefore best-effort for
a process that is actively awaiting inside a reducer.

### Does not cascade

`forceStop()` kills *this* process only. Its own children are abandoned (still
referenced by the dead process's `children` list until GC). The caller
force-stops them separately if it owns them. (Open question: should this
cascade? Leaning no — keep the primitive narrow.)

## Relationship to other proposals

- Consumed by `orphan-policy.md`'s `force-stop` policy (`onOrphan` returning
  `'force-stop'`).
- Orthogonal to `process-links.md` (it drains the `adopt`/`monitor`
  subscriptions those primitives created).

## Open questions

- Cascade to children, or leave them abandoned? (Leaning: no cascade.)
- Should `wait()` resolve or reject on a hard kill? (Currently: resolve — the
  caller "doesn't care", and a kill is not an error.)
