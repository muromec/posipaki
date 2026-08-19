# posipaki: pause — freeze emission too (bidirectional quiesce)

> **Status**: Idea. Back of the drawer.

## Summary

`pause()` currently freezes only the *incoming* direction — it stops scheduling
ticks, so the process stops **processing** messages. It does **not** stop the
*outgoing* direction: a process can still emit via `ctx.toParent` (and, via async
callbacks, even while paused). This makes `pause()` a half-working quiesce.

Make `pause()` freeze **both** directions: no processing *and* no emission.

## Motivation

A true "quiesce" is useful any time you want a process to go quiet without
killing it — draining it, snapshotting state, or handing it off. Today `pause()`
leaves a gap: the process goes silent on input but can still produce output.

## Design sketch

- Gate `ctx.toParent` on the paused flag. While paused, emissions are buffered
  (not dropped) in an outgoing hold queue.
- `resume()` flushes the hold queue before resuming dispatch, so no message is
  lost and order is preserved.
- Async-callback emission (timers, fetch) bypasses the dispatch loop; it would
  need to route through the same gated `ctx.toParent`, so the gate covers it too
  (unlike the current half-working `pause()`).

## Open questions

- Buffer or drop emissions while paused? (Leaning: buffer, for losslessness.)
- Does `resume()` flush before or after re-enabling dispatch?
- Does this subsume the orphan-policy collector, or stay a separate primitive?

## Relationship

- Supersedes the "half-working" note on `pause()` in `process.async.ts`.
- Possibly overlaps with `orphan-policy.md`'s collector (both are "buffer
  outgoing messages during a transition") — reconcile before implementing.
