# BUG-008: a process on the far side cannot be looked up by name

**Found:** 2026-09-19, live, in the same walk that found BUG-007.

**Symptom:** the tree shows a far process by a name, and handing that name back does not
resolve it: `actor_state` answers `(actor not found: …)`.  Today the name shown is the far
side's own (`remote:task-1`, BUG-007); once the naming is settled it would be a name of this
side's, and the answer would still be the same, because the search never leaves this side.

**Root cause:** `findProcess` (`src/plugins/tree-introspection.ts`) walks `selfCtx.children`,
which holds this side's processes.  A child that is a handle on a process over the seam keeps
its far subtree out of reach here, and its own `find` is never asked.

**Fix:** open.  `find` would have to descend through a child whose processes live on the other
side, asking that child with the name it uses over there and reading the answer as a reference.
That changes what `inspect.find` returns — a far handle answers over the seam, so `state` and
`stop` on it work — and it wants deciding rather than assuming.

**Tests:** none yet.
