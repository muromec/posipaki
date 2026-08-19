# posipaki: Process links — generalize parent-child communication

> **Status**: Idea. Rough concept; no design yet.

## Summary

Replace the special-cased parent↔child wiring in `fork` with a generic
**emit → subscribe** model, exposed as a `link` primitive on the *receiver*:

```ts
parent.link(child);
// ≡
child.subscribe("message", (event) => parent.send(event, child.from));
```

`subscribe` is generalized into a discriminated, typed API:

```ts
proc.subscribe("message", MsgCallback<OutMsg>);   // emitted messages
proc.subscribe("state",   StateCallback<State>);  // reactive state
```

- `fork` becomes "spawn a child, then `this.link(child)`".
- Adopting an orphan becomes `this.link(orphan)`.
- The root actor's `spawn(opts.toParent)` stays a supported shortcut (not
  deprecated) over `subscribe("message", …)`.

## Motivation

Today parent-child communication is a hard-coded special case. `fork` manually
wires `child.toParent = parent.fromChild.bind(parent)` — a single, fixed parent
slot. `ctx.toParent(msg)` then funnels every message to that one callback. The
root actor, by contrast, passes a `toParent` callback to `spawn` instead of
subscribing — the same "I emit, you listen" idea implemented two different ways.

This is wrong on three counts:

- **Single parent.** A process can emit to exactly one destination. There is no
  fan-out, and no way for a second observer to tap a process's output.
- **Adoption is a hack.** Orphan adoption (see `orphan-adoption-on-exit.md`)
  has to reach into the orphan and re-point `toParent` / `parentName` /
  `parentId` by hand, because the parent link is a mutable slot rather than a
  subscription.
- **Two ad-hoc channels.** `toParent`/`fromChild` (messages) and the existing
  `subscribe` (state) overlap without a unifying shape.

## Design sketch

- **`subscribe` becomes discriminated** by channel:
  ```ts
  proc.subscribe("message", MsgCallback<OutMsg>);   // fires on emit
  proc.subscribe("state",   StateCallback<State>);  // fires on state change
  ```
  The existing `subscribe(f)` (a state ping) stays as a **deprecated**
  shortcut for `subscribe("state", f)`.
- **`link(child)`** subscribes the receiver to the child's *message* channel,
  preserving sender provenance through the existing `send(msg, from)`:
  ```ts
  link(child) {
    child.subscribe("message", (event) => this.send(event, child.from));
  }
  ```
  `child.from` is `{ fromName: child.pname, fromId: child.id }`.
- **`fork`** = spawn child + `this.link(child)`. No manual `toParent` wiring.
- **Adoption** = `this.link(orphan)`. No manual `toParent` / `parentName` /
  `parentId` mutation.
- **Root actors** keep `spawn(opts.toParent)` as a supported (non-deprecated)
  shortcut — sugar for `subscribe("message", cb)`.
- Multiple subscribers per channel; `subscribe` returns an unsubscribe function.

## Relationship to orphan adoption

`orphan-adoption-on-exit.md` currently describes "adopt" as re-pointing
`toParent` / `parentName` / `parentId`. With `link`, that collapses to
`this.link(orphan)` — the orphan's messages flow to the adopter like any other
subscription, stamped with the orphan's identity.

## Open questions

- **Callback signatures.** Pin down `MsgCallback<OutMsg>` (does it receive the
  raw message or the `[msg, sender]` tuple?) and `StateCallback<State>`
  (does it receive the state value, or stay a no-arg ping?).
- **`emit` vs `ctx.toParent`.** Does `emit` replace `ctx.toParent` outright, or
  is `ctx.toParent` kept as a thin shim over `emit`?
- **`fromChild` / `toParent` migration.** The EXIT-filtering in `fromChild`
  (removing the child from `this.children`) still needs a home in the new model.
- **`notify()` for state.** If `StateCallback` receives the state value, the
  existing no-arg `notify()` call sites change; confirm that's wanted.
