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

**Fix:** the name is settled at the seam, where the connection is made, instead of being
rewritten where it is read.  `$init` states the root's name fully qualified — the process a
payload serves is the client's own end of the connection, so it is called over there what it is
called here — and the server spawns the served root under it, which spells the whole subtree off
the same name (`838f8d7`, released as 0.37.1).  `SERVED_ROOT_NAME` is what a connection that
states nothing still gets.  Rewriting the names where they are *presented* (the introspection
plugin) was tried first and thrown away: the mismatch was upstream of the walk, and every reader
would have needed the same translator.

**Tests:** `src/remote/reflection.integration.test.ts` — over a real fifo payload, a host that
forks the client walks its own tree and reads `host:tools` and `host:tools:kid`;
`src/remote/client.test.ts` asserts the frame carries `rootName`, and
`src/remote/reflection.test.ts` that a reference to the far root is the handle this side already
holds, named as this side named it.
