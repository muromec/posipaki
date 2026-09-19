# BUG-008: a process on the far side cannot be looked up by name

**Found:** 2026-09-19, live, in the same walk that found BUG-007.

**Symptom:** the tree shows a far process by a name — `…:tools:isolated:task-1` since BUG-007
— and handing that name back does not resolve it: `actor_state` answers `(actor not found: …)`,
because the search never leaves this side.

**Root cause:** `findProcess` (`src/plugins/tree-introspection.ts`) walks `selfCtx.children`,
which holds this side's processes.  A child that is a proxy for a process over the seam holds no
children here, its far subtree is not part of this side's object graph, and its own `find` is
never asked.  The method was installed and reachable the whole time — `inspect.getTree` crossed
the same boundary all along, because it *asks* each child, while `find` only *looked*.

**Fix:** `find` is written the way the walk is: a level knows its own children and answers
for them one at a time.  A child that is the name is the answer, since it is held here.  A
child that can answer is asked and its answer is the answer — what is under it is its own
business, and when it lives on the far side of a seam the asking is the only way across.  A
child that announces nothing is searched where it is, as a process with no methods still
holds its own children as objects.

Nothing has to be agreed about plugins over the wire: a child announces what the process
behind it can answer on the frames it already sends, so the far side serves what its own
plugins installed, and a child that installed nothing is looked at instead of asked.

What a far side hands back is a handle, not an object of this side's tree, so the declared
return type is `FoundProcess` (`AnyProcess | FarProcess`).  A handle is a name, what the
process holds, the methods it announced and a way to end it.  Reading `.state` on one reports
nothing until `tune(["state"])` has been asked for, because a process that crossed is silent:
how a consumer reads state on a handle is its own decision, not something a search decides
for it.

**Tests:** `src/plugins/tree-introspection.test.ts` — a child that announced the method is
asked and its answer is returned; each child that can answer is asked in order, and the first
answer wins; what a child that announced nothing keeps of its own is still searched; a child
that is the name is handed back without anyone being asked.  `src/remote/reflection.integration.test.ts`,
over a real fifo payload — a host that forks the client finds `host:tools:watcher` through the
proxy, the handle answers `inspect.getState`, and its state arrives once it has been tuned for.
The payload fixture grew an inspected child (`watcher`) so a handle found over the seam has
something to answer with.
