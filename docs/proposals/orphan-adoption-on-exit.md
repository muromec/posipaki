# posipaki: Orphan adoption on process exit

> **Status**: Idea. Rough concept; no design yet.

## Summary

When a process exits, its parent takes over the exiting process's still-running
children, so no running actor is ever disconnected from the tree.

```
P1 ── P2 ── P3            P2 exits (P3 keeps running)
          ── P4
    becomes
P1 ── P3   (in $orphans)
    ── P4   (in $orphans)
```

Adopted children are placed in `$orphans`, a collection distinct from
`$children`, so an actor can tell "my own children" from "orphans I inherited".
Actors can then define their own behavior for orphans: force-stop them, adopt
them (promote to `$children`), or leave them running under observation.

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

## Design sketch

- On exit, before/after the STOP cascade, the exiting process's **parent**
  adopts any children that are still running.
- The parent stores adopted processes in `$orphans` (keyed by pname), separate
  from `$children`.
- The actor can then act on orphans via actor-specific behavior:
  - **force-stop** — send STOP (or a harder abort) and reap,
  - **adopt** — promote the orphan from `$orphans` to `$children` and treat it
    as its own,
  - **leave** — keep it running in `$orphans` (observable, but not a
    first-class child).

## Implication: tree inspector

The tree inspector (`src/plugins/tree-introspection.ts`, `inspect.getTree()`)
walks `this.ctx.children` and recurses into each child's own
`inspect.getTree()`. It has no notion of adopted orphans.

If orphans are stored in `$orphans` rather than `ctx.children`, they vanish
from the tree — which defeats the entire point of keeping them observable. So
adoption requires a matching inspector change:

- `inspect.getTree()` must also walk `$orphans`, and
- the `TreeNode` shape must mark adopted nodes distinctly — e.g. a
  `status: "orphan"`, or a parallel `orphans: TreeNode[]` field — so a viewer
  can tell an inherited orphan from a first-class child.

Without this, "reachable through the tree" is only true in the actor internals,
not in the introspection surface operators actually use.

## Open questions

- How the parent learns the orphan's process handle: does the exiting process's
  EXIT message carry its still-running children, or is there a separate
  re-parenting signal?
- Whether adoption happens before or after the cascading-stop timeout (the
  orphans are exactly the children that refused STOP).
- Whether the orphan's `ctx.parentName`/`parentId` are updated to the
  grandparent (so future `toParent` messages route somewhere meaningful) or
  left pointing at the dead parent.
- Tree naming: does the orphan keep its original `P1:P2:P3` name, or is it
  renamed on adoption?
- How `$orphans` interacts with the STOP cascade on the *new* parent's own
  exit (do orphans get STOPped too?).
- How `inspect.getTree` marks orphans (status field vs. separate array), and
  whether the low-level `ctx.children` view and the decorated `$orphans` view
  can diverge.
