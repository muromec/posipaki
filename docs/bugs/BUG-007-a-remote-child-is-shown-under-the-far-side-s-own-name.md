# BUG-007: a remote child is shown under the far side's own name

**Found:** 2026-09-19, live, walking a persona's tree right after the tool server gained
introspection (`email-agent` `cf002bb`).  Measured, not reasoned about.

**Symptom:** a tool server running in a process of its own appears in the tree as `remote` — a
name belonging to no tree here — beside the in-process one:

```
persona:butler:openai
  persona:butler:openai:tools:inline
    persona:butler:openai:tools:inline:task-6
  remote
    remote:task-1
```

`…:tools:isolated`, the name this side forked the server under and the one `inspect.find`
answers to, is nowhere in the walk.  `actor_state` on `remote` answers `(actor not found:
remote)` while the local name resolves.  A second persona with a spawned environment is called
`remote` too, so the label cannot tell two of them apart.  The tree reads differently depending
on which side a process runs on, which is the one thing it should not do.

**Root cause:** the two sides never agree on a name for the root, and no frame carries one.
`SERVED_ROOT_NAME` — `remote` (`src/remote/process-ref.ts`) is the name the served root is
spawned under over there, "since no frame about a root carries a name of its own"; the far side
spells its whole subtree off it, and the client's own table of the far side is keyed by it as
well.  The side that started the connection is the one that knows a better name — the pname the
proxy was forked as — and nothing asks it.

**Fix:** open.  The agreement belongs at the seam, where the connection is made: the name the
client uses for the far root is its own process's pname, so what is missing is a way to state
it — in the way-in arguments one spawn composes, or in the handshake that opens the channel —
and the far side spawns (or renames) its root under it.  Rewriting the names where they are
*presented* (the introspection plugin) was tried and thrown away: the mismatch is upstream of
the walk, and every reader would need the same translator.

**Tests:** none yet.
