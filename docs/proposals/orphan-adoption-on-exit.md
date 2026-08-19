# posipaki: Orphan adoption on process exit

> **Status**: Draft proposal. Core decisions resolved; no code yet.

## Summary

When a process exits, its still-running children (and any orphans it was
holding) are handed to its parent, so no running actor is ever disconnected
from the tree.

```
P1 ── P2 ── P3            P2 exits (P3 refuses STOP, keeps running)
    becomes
P1 ── orphans: P3         (collected into ctx.orphans)
```

The low-level primitive (`ProcessCtx`) just **collects** these into
`ctx.orphans`, a collection alongside `ctx.children`. The higher-level
`defineActor` owns the policy — the "fancy tools" to adopt, force-stop, or
leave an orphan.

## Motivation

Today a child that survives its parent becomes an **orphan**: its parent has
exited, so

- it is not reachable through the normal process tree (nobody observes it,
  nobody can signal it),
- its `toParent` messages go nowhere (the parent is gone).

The second point is acceptable — a root actor's `toParent` messages go nowhere
too, and that is fine. The first point is not: a running actor that is
unreachable and unobservable is a leak with no handle. It can hold sockets,
timers, and state indefinitely, and the only remedy is killing the whole
process group.

This is a live consequence of the cascading-stop proposal: when a parent STOPs
its children and a child refuses to stop, the parent times out and exits,
leaving the refusing child orphaned.

## Design decisions (resolved)

- **`ctx.orphans` is the low-level collection.** `ProcessCtx` gains an `orphans`
  array alongside `children`. `children` = forked by me; `orphans` = inherited
  from a child that exited.
- **The low-level primitive only collects.** When a child's EXIT arrives
  carrying its surviving children (in-process handles, nothing serialized), the
  low-level appends them to `ctx.orphans`. No policy — no auto-stop, no
  auto-adopt.
- **Orphans propagate up.** On my own exit, my surviving `children` plus my
  `orphans` are carried in my EXIT to my parent, which collects them into *its*
  `orphans`. An orphan keeps bubbling up until some `defineActor` handles it.
- **`defineActor` owns the policy.** It exposes tools over `ctx.orphans`:
  - **adopt** — re-point `toParent` / `parentName` / `parentId` and promote the
    process from `orphans` to `children` (its messages now reach me),
  - **force-stop** — send STOP (and reap) now,
  - **leave** — do nothing; it propagates up on my exit.
- **In-process only.** The remote-actor path serializes EXIT and cannot carry
  process handles.

## Design sketch

- On exit, the exiting process collects the children that refused STOP and
  survived the cascade timeout, plus its own `orphans`.
- Its EXIT message carries those handles to the parent.
- The parent's low level appends them to `ctx.orphans`.
- `defineActor` actors then apply policy via the tools above.

## Implication: tree inspector

Orphans are reachable via `ctx.orphans`, so `inspect.getTree()` must walk
`ctx.orphans` in addition to `ctx.children`, marking adopted nodes distinctly
(e.g. `status: "orphan"`) so a viewer can tell an inherited orphan from a
forked child.

## Open questions

- Where the low-level collection is wired: `fromChild` (which owns
  `ctx.children` / would own `ctx.orphans`) vs the `defineActor` EXIT branch —
  the two levels must coordinate without duplicating state.
- Tree naming: does an orphan keep its original `P1:P2:P3` name, or is it
  re-named on adoption?
- Does "force-stop" also remove the orphan from `ctx.orphans`, or only STOP it?
- Should `defineActor` expose `this.orphans` as a decorated view, or do actors
  reach straight into `ctx.orphans`?
