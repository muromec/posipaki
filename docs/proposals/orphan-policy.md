# posipaki: Orphan policy (actor-level tools)

> **Status**: Idea. Design revised (2026-08-19) — `adopt` is a buffered, lossless handoff.

## Summary

`defineActor` exposes the policy tools over the low-level `ctx.orphans`
collection (see `ctx-orphans.md`): **adopt**, **force-stop**, or **leave** an
orphan.

`adopt` is the interesting one: it must be a **buffered cutover** — the orphan's
in-flight messages are preserved across the change of ownership, not dropped in
the gap between the old parent dying and the new parent subscribing.

## Motivation

The low level only *collects* orphans — it makes them reachable but takes no
action. A naive `adopt` ("subscribe to the orphan") loses every message the
orphan emits during the handoff window. This proposal defines `adopt` so that
window has no hole.

## The footgun

When parent P exits and its child C survives (refuses STOP), C is handed up as
an orphan. Two loss windows:

- **Window A — addressed to a dying process.** C emits M to P while P is
  exiting; M lands in P's inbox and is discarded with P. For a child that *also*
  exits (stops cleanly), this is accepted — it's going away and its in-flight
  messages die with it.
- **Window B — the handoff limbo.** After P unsubscribes from C but before the
  grandparent G adopts C, C has zero subscribers; messages go to nobody.

Window B is the one `adopt` must close. Window A is closed for orphans by
buffering at the boundary; for children that stop cleanly, the loss is accepted.

## Design

### Policy tools (hook-shaped)

The actor declares an `onOrphan(orphan)` hook. When the runtime collects an
orphan, it calls the hook and applies the returned decision:

```ts
onOrphan(orphan) {
  return 'adopt' | 'force-stop' | 'leave';
}
```

- **adopt** — take ownership via the buffered handoff below. The orphan is
  promoted from `orphans` to `children`, and its in-flight messages are
  preserved.
- **force-stop** — hard-kill the orphan (`AsyncProcess.forceStop()` — see below)
  and remove it from `ctx.orphans` imperatively; drop its pending buffer. The
  same applies to own children, which can also be force-stopped.
- **leave** — do not adopt; remove the collector callback and drop the pending
  buffer; the orphan propagates up on my exit.
- The default, when the actor defines nothing, is **leave**.

#### force-stop is a hard kill, not a STOP message

`force-stop` is *not* `send(STOP)`. STOP is graceful — the generator cooperates
and emits EXIT. `force-stop` terminates the process immediately: no generator
`finally`, no EXIT, nothing left to observe. It is a method on `AsyncProcess`
(currently missing), and the caller removes the process from its `children` /
`orphans` list imperatively, because there is no EXIT to do that cleanup.

### adopt — the buffered handoff

The core-level protocol lives in `AsyncProcess` (not `defineActor`-specific; any
process can do it):

1. Run the STOP cascade + await (with timeout), as today. The children that did
   not stop within the timeout are the **orphans to hand over**. A child that
   stopped cleanly is simply gone — anything it emitted while we were exiting is
   lost with it, and that's fine.
2. For each orphan, **swap its callback to a dumb collector** — replace the
   `pvtChildMessage` subscriber with one that only buffers `[msg, from]` (no EXIT
   filtering, no policy). The swap is two synchronous statements, so it is an
   *atomic cut* (see below).
3. **Back-feed** — sweep P's *own* inbox for undrained messages from each orphan
   (`sender.fromId === orphan.id`) and distribute them into the orphan's buffer,
   *ahead of* whatever the collector has already buffered (they predate the cut).
4. **Hand off** — P's EXIT carries the orphans, and in a **separate payload
   field** their pending buffers (`orphans` + `pending` keyed by process id). The
   buffers are *live*: the collector keeps appending while the handoff is in
   flight.
5. **On adopt** — G subscribes to the orphan first, removes the collector, then
   drains the (still-growing) buffer into G's inbox. Order is back-fed →
   collector → live.

Ordering falls out of the cut: back-fed (oldest) → collector (newer) → live
post-adopt (newest).

### The leak is G's problem

The collector buffers without bound while the orphan is unowned. If G adopts,
the drain empties it. If G does not adopt (`leave`/`force-stop`), G removes the
collector callback and drops the buffer. No pause is involved; `pause()` freezes
dispatch but not async-callback emission, so it is deliberately out of scope
here (and marked half-working in the source).

### Why the cut is atomic

`subscribe`/`unsubscribe` are synchronous, and JavaScript runs a job to
completion — there is no `await` between the two statements. The orphan's
emission runs in its own macrotask and observes either the before-state or the
after-state, never the intermediate. No gap, no duplication. The collector may
equally be a mode switch inside `pvtChildMessage` (a flag: `send` vs
`buffer.push`) — equivalent, less bookkeeping.

## Relationship to other proposals

- Depends on `ctx-orphans.md` — the EXIT payload gains a separate `pending`
  buffer alongside `orphans`.
- Depends on `process-links.md` — `adopt`/`monitor` and the discriminated
  `subscribe` are the primitives the collector and the subscribe/drain steps are
  built on.
- `force-stop` and `leave` need no new core mechanism.

## Open questions

- **Buffer transport shape.** `pending` as a `Map<symbol, WithSender<Message>[]>`
  or a parallel `Array<[AnyProcess, WithSender<Message>[]]>`?
- **force-stop primitive.** `AsyncProcess.forceStop()` does not exist yet; it
  must hard-terminate (abandon the generator without running its `finally`, clear
  buffer/subscribers, resolve `wait()`). Confirm that's the desired semantic vs
  `generator.return()` (which *does* run the `finally`).
- **Remote.** EXIT is in-process only; remote orphans cannot carry buffers.
  Accepted (same as `ctx-orphans.md`).
