# posipaki: process termination — stop() escalation ladder + forceStop()

> **Status**: Implemented (2026-08-19).

## Summary

Two primitives terminate a process, on an escalation ladder:

- `proc.stop(opts?: { force?: boolean; from?: SenderInfo })` — the **nice** way,
  then (optionally) the **escalation**.
- `proc.forceStop()` — the final **abandon** rung, for when the nice way was
  already tried.

The guiding principle: be nice and let the process run its `finally` (where
`afterEnd` frees resources), but never dead-lock ourselves waiting for a process
that is stuck awaiting a dead promise or looping back on us.

## The ladder

`stop()`:

1. **STOP** — send STOP (the nice way; the generator cooperates and its
   `finally` runs). Await on a best-effort basis with a timeout (we can't wait
   forever — whatever it awaits may never happen because it bugged out).
2. **return() fire-and-forget** — if it refused and `force` is set, fire
   `generator.return()` *without awaiting*: throw the generator away for GC to
   find. This gives the `finally` a chance to run, but we do not block on it.
3. **Cascade** — proceed to stop its children with the same ladder
   (`child.stop({ force: true })`).
4. **Abandon** — `forceStop()`: drop the generator, clear inbox/observers,
   settle `wait()`/`ready()`.

`stop()` resolves `true` if the process stopped (gracefully or forced), `false`
if it refused and `force` was not requested.

## `forceStop()` — the abandon rung

`forceStop(opts?: { cascade?: boolean })` is the hard kill, used when the nice
way was already tried:

1. marks the process dead (a `pvtDead` flag guards `send`/`pvtScheduleTick`),
2. abandons the generator (`current = null`) so its `finally` never runs,
3. drops the inbox and stops scheduling,
4. releases incoming observers and drains outgoing `adopt`/`monitor`
   subscriptions,
5. settles `wait()` and `ready()`,
6. with `{ cascade: true }`, stops the children too — **starting with the nice
   stop** (`child.stop({ force: true })`), fire-and-forget so the hard kill
   itself does not block.

There is **no EXIT**. The caller removes the process from its `children`/
`orphans` list imperatively — exactly one place owns that list mutation,
matching "ownership where state lives". Applies to children and orphans alike.

### Best-effort caveat

JS offers no way to cancel a pending promise. An *idle* generator (suspended at
`yield`) is abandoned cleanly — its `finally` never runs. A generator mid-`await`
will complete its `finally` when that `await` settles, because the pending
promise still holds the continuation. Both `return()` and abandonment are
therefore best-effort for a process actively awaiting inside a reducer.

## Relationship to other proposals

- Consumed by `orphan-policy.md`'s `force-stop` policy (`onOrphan` returning
  `'force-stop'`).
- The cascade in `pvtWatchExit` now delegates to `child.stop()` (nice) rather
  than the previous `toAllChildren(STOP)` + manual timeout.

## Open questions

- Should `wait()` resolve or reject on a hard kill? (Currently resolve — a kill
  is not an error.)
