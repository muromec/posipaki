# posipaki: Orphan policy (actor-level tools)

> **Status**: Idea. Rough concept; no design yet.

## Summary

`defineActor` exposes the "fancy tools" over the low-level `ctx.orphans`
collection (see `ctx-orphans.md`): **adopt**, **force-stop**, or **leave** an
orphan.

## Motivation

The low level only *collects* orphans — it makes them reachable but takes no
action. The actor owns the policy for what to do with them.

## Design

- **adopt** — make the orphan a first-class child: `this.link(orphan)` (see
  `process-links.md`) re-points its output to me, and it is promoted from
  `orphans` to `children`.
- **force-stop** — send STOP (and reap) now.
- **leave** — do nothing; the orphan propagates up on my exit.
- The default, when the actor defines nothing, is **leave**.

## Relationship to other proposals

- Depends on `ctx-orphans.md` (the collection it operates on).
- Depends on `process-links.md` (`adopt` is `link`).

## Open questions

- Should `defineActor` expose `this.orphans` as a decorated view, or do actors
  reach into `ctx.orphans` directly?
- Does "force-stop" remove the orphan from `ctx.orphans`, or only STOP it?
- Tools as methods (`this.adopt(orphan)`) or a lifecycle hook (`onOrphan`)?
