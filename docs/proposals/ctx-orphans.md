# posipaki: ctx.orphans — orphan collection (core-level)

> **Status**: Idea. Rough concept; no design yet.

## Summary

`AsyncProcess` / `ProcessCtx` gain an `orphans` collection alongside
`children`. The low-level runtime mechanically collects surviving grandchildren
there and passes them up on exit.

This is a **core-level** primitive and lives entirely outside `defineActor` —
`defineActor` may as well not exist. It applies to any process, including raw
`spawnAsync` generators.

```
P1 ── P2 ── P3            P2 exits (P3 refuses STOP, keeps running)
    becomes
P1 ── orphans: P3
```

## Motivation

A child that survives its parent (refuses STOP, or the parent dies) is today
disconnected: nobody observes it, nobody can signal it, and it can hold
sockets / timers / state forever. The fix has two halves — **collection** (this
proposal, the small core-level half) and **policy** (the actor-level proposal,
`orphan-policy.md`). This one only makes the orphan *reachable*.

## Design

- `AsyncProcess.orphans: Array<AsyncProcess<...>>` — a second collection; the
  existing `ctx` exposes it as `ctx.orphans` (same array, like `ctx.children`).
- **Collect on child EXIT.** A child's EXIT message carries its still-running
  children (in-process handles). The parent's `fromChild` appends them to
  `this.orphans` when it sees the EXIT — alongside its existing job of removing
  the exiting child from `this.children`.
- **Propagate on own EXIT.** In `pvtWatchExit`'s `finally`, after the STOP
  cascade + await, my surviving `children` plus my `orphans` are carried in my
  EXIT to my parent, which collects them into *its* `orphans`. An orphan keeps
  bubbling up until some actor handles it.
- **No policy.** The low level does not auto-stop or auto-adopt orphans — that is
  the actor-level proposal's job.
- **Naming is kept.** An orphan keeps its original tree name (e.g. `P1:P2:P3`)
  — it reflects where it was forked, not its current parent. Intentional.

## Where it is wired

All in `src/process.async.ts` (+ the `ProcessCtx` type):

- `pvtWatchExit` — collects survivors and orphans into the EXIT payload.
- `fromChild` — on EXIT, removes the dead child and appends the carried orphans
  to `this.orphans`.

No `defineActor` involvement.

## Open questions

- In-process only — the remote path serializes EXIT and cannot carry handles.
