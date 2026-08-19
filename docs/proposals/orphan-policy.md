# posipaki: Orphan policy (actor-level tools)

> **Status**: Idea. Design revised (2026-08-19) to make `adopt` a lossless,
> buffered handoff rather than a bare re-subscribe.

## Summary

`defineActor` exposes the policy tools over the low-level `ctx.orphans`
collection (see `ctx-orphans.md`): **adopt**, **force-stop**, or **leave** an
orphan.

`adopt` is the interesting one. It must be a **buffered cutover** — the orphan's
in-flight messages are preserved across the change of ownership, not dropped in
the gap between the old parent dying and the new parent subscribing.

## Motivation

The low level only *collects* orphans — it makes them reachable but takes no
action. A naive `adopt` ("subscribe to the orphan") loses every message the
orphan emits during the handoff window. This proposal defines `adopt` so that
window has no hole.

## The footgun

When parent P exits and its child C survives (refuses STOP), C is handed up as
an orphan. There are two distinct loss windows:

- **Window A — addressed to a dying process.** C emits M to P while P is in its
  exit cascade. M lands in P's inbox (via the `adopt` subscriber → `send`) and
  is discarded when P dies. This is at-most-once, Erlang-mailbox semantics.
- **Window B — the handoff limbo.** After P unsubscribes from C but before the
  grandparent G adopts C, C has zero subscribers; messages go to nobody.

Window B is a bug we can fix. Window A is fundamental *only if* we commit the
message to P's inbox; the `adopt` protocol below sidesteps that by buffering at
the handoff boundary instead.

## Design

### Policy tools

- **adopt** — take ownership of an orphan via the buffered handoff below. The
  orphan is promoted from `orphans` to `children`, and its in-flight messages
  are preserved.
- **force-stop** — STOP the orphan (and reap) now.
- **leave** — do nothing; the orphan (and its pending buffer) propagates up on
  my exit.
- The default, when the actor defines nothing, is **leave**.

### `adopt` — the buffered handoff

The core-level protocol lives in `AsyncProcess` (this is not `defineActor`-specific;
any process can do it):

1. **Pause** the orphan C — freeze its dispatch so it stops emitting new
   message-driven work. (Caveat: `pause()` freezes *dispatch*, not async-callback
   emission; see open questions.)
2. **Cut C's routing to a dumb collector** — replace the `pvtChildMessage`
   subscriber with a collector that only buffers `[msg, from]` (no EXIT
   filtering, no policy). The swap is two synchronous statements, so it is an
   *atomic cut*: C's emission observes either the old handler or the collector,
   never both and never neither (see below).
3. **Back-feed** — scan P's *own* inbox for undrained messages from C
   (`sender.fromId === C.id`) and move them into C's collector buffer, ahead of
   the collector-captured messages (preserving emission order).
4. **Hand off with the buffer** — P's EXIT carries the orphan *and* its buffered
   messages (in-process handles; the EXIT is already in-process only).
5. **On adopt** — G subscribes to C first, removes the collector, drains the
   buffer into G's inbox (back-fed → collector → live, in order), then resumes C.

Ordering falls out of the cut: back-fed (oldest) → collector (newer) → live
post-resume (newest), which preserves C's emission order across the transfer.

### Why the cut is atomic

`subscribe` and `unsubscribe` are synchronous, and JavaScript runs a job to
completion — there is no `await` between the two statements. C's emission runs
in its own macrotask, so it sees the before-state (`[old]`) or the after-state
(`[collector]`), never the intermediate `[old, collector]`. No gap, no
duplication. The collector may equally be a mode switch inside `pvtChildMessage`
(a flag: `send` vs `buffer.push`) — equivalent, less bookkeeping.

### What the collector is

A "dumb" subscriber: it buffers and does nothing else. It has no policy and no
EXIT handling. Its only job is to keep messages that would otherwise be
committed to a dying inbox.

## Relationship to other proposals

- Depends on `ctx-orphans.md` (the collection) — the EXIT payload gains a
  `pending` buffer alongside `orphans`.
- Depends on `process-links.md` — `adopt`/`monitor` and the discriminated
  `subscribe` are the primitives the collector and the subscribe/drain steps are
  built on.
- `force-stop` and `leave` need no new core mechanism.

## Open questions

- **Buffer transport.** Should the buffered messages ride in the EXIT payload
  (`orphans` + a parallel `pending` map keyed by process id), or be attached to
  the orphan process object itself?
- **Eager vs lazy collector.** Install the collector for *all* children at the
  start of the exit cascade (discard buffers for children that stop cleanly), or
  only for detected orphans after the timeout? The former is simpler; the latter
  installs fewer collectors.
- **Pause vs async emission.** `pause()` freezes dispatch, not async callbacks.
  A chatty orphan that emits from timers/fetch will still grow the collector
  buffer while orphaned. Bound it, or accept unbounded buffering?
- **Exposure.** Should `defineActor` expose `this.orphans` as a decorated view,
  or do actors reach into `ctx.orphans` directly?
- **Shape.** Tools as methods (`this.adopt(orphan)`) or a lifecycle hook
  (`onOrphan`)? And does `force-stop` remove the orphan from `ctx.orphans`, or
  only STOP it?
