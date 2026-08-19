# posipaki: ctx.orphans — orphan collection (core-level)

> **Status**: Idea. Rough concept; no design yet.

## Summary

`ProcessCtx` gains an `orphans` array alongside `children`. The low-level
`AsyncProcess` mechanically collects surviving grandchildren there and passes
them up the tree on exit. No policy — this is just the collection primitive.

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

- `ctx.orphans: Array<AsyncProcess<...>>` — a second collection on `ProcessCtx`,
  alongside `ctx.children`.
- **Collect on child EXIT.** A child's EXIT message carries its still-running
  children (in-process handles, nothing serialized). The parent appends them to
  `ctx.orphans`.
- **Propagate on own EXIT.** When I exit, my surviving `children` plus my
  `orphans` are carried in my EXIT to my parent, which collects them into *its*
  `orphans`. An orphan keeps bubbling up until some actor handles it.
- **No policy.** The low level does not auto-stop or auto-adopt orphans — that is
  the actor-level proposal's job.

## Open questions

- Where collection is wired: the low-level `fromChild` (owns `ctx.children`) vs
  the `defineActor` EXIT branch (owns the decorated map).
- Tree naming on propagation: keep the orphan's `P1:P2:P3` name or re-name it.
- In-process only — the remote path serializes EXIT and cannot carry handles.
