# posipaki: `self` on the process context

> **Status**: Implemented.

## Summary

`ProcessCtx` gains `self`: the running process, as the thing others can be handed and send
to.  `ActorContext` gains the same value as `this.self`, typed as the actor's own process.

```ts
interface ProcessCtx<Args, State, IM extends Message, OM extends Message> {
  pname: string;
  id: symbol;
  self: AsyncProcess<Args, State, IM, OM, {}>; // NEW
  // ... rest unchanged
}
```

## Motivation

A process is reachable because somebody holds it.  A name and a symbol say who a message
*came from* (`SenderInfo`) — they are provenance, not an address: there is no registry, and
nothing can be sent to a name.  Only a handle can be sent to, and until now the one handle
no process could obtain was its own.

What a context offered instead was identity without reachability: `pname`, `id`,
`parentName`, `parentId`, and `sendSelf` — a closure that injects into the process while
stamping the process itself as the sender, which is the wrong answer to "who is asking".
An actor's `$child` and `fork` give it handles to its children and to nobody else.  Its
parent holds *it*, and on the far side of a served connection its parent is a name that
exists on the other machine.

The case that asked for this is a served root that must be reached by a process which is
neither its parent nor its child.  A service hosts a router and serves one connection actor
per socket; the router has to hold the connections.  The connection actor can only hand over
what it has, and what it had was a name.  `self` is that hand-over: put it in a message body
and whoever receives it can talk back — locally, or across a seam, where a reference crosses
like any other process (`$p`).

## Design

- **Born where the process is.**  The context object is built inside `AsyncProcess.start()`,
  which is the one place the process itself is in hand; `self: this` there.  `define-actor`
  only ever receives that context, so the actor's `this.self` is taken from it rather than
  invented.
- **It is the process, not a description of it.**  `self` is the same object a spawner gets
  from `spawn()`, a parent holds in `children`, and a far side receives as a handle.  There
  is one object per process; `self.pname` and `self.id` are the context's own.
- **Typed by shape.**  `self` is `AsyncProcess<Args, State, IM, OM, {}>` — the process's own
  argument, state and message types — so `this.self.send(...)` accepts exactly the messages
  this actor takes, and refuses the ones it does not (there is a `@ts-expect-error` for that
  in `src/self-reference.test.ts`).  An actor's is the actor's process, reflection surface
  included.

### What the precise type costs, and what pays for it

A context carrying `self` is no longer interchangeable with a context of another shape: the
process type is invariant in its arguments (`pgenerator`, `start()`), so
`ProcessCtx<A, S, IM, OM>` is only assignable to another context of the same shape.  That is
the honest reading — a context *is* that process's — but it made two long-standing loose
declarations visible:

- **`ProcessCtx.toParent`** was declared `OM` while the framework built the context with
  `OM | ExitMessage`, because the channel carries the framework's EXIT as well as the
  process's own out-messages.  It is now declared `OM | ExitMessage`, and the context is
  built at the process's own shape instead of a widened one.
- **`spawnAsChild`** took `ProcessCtx<unknown, unknown, OutMsg, PMO>`, a claim no concrete
  context can meet once the context is typed by its own shape — and a claim it never needed:
  the only thing it uses from the parent's context is `fork`.  Its parameter is now
  `ForkSite` (`Pick<ProcessCtx<…>, "fork">`), and the `<PMO>` type parameter — which existed
  only to describe that parameter — is gone.  `spawnAsChild(this.ctx, …)` still needs no
  cast.

The check that matters is not lost: the child's out-messages must fit the parent's
in-messages, and that is checked where the parent's own type is in hand — `this.fork(child)`
in an actor, whose `OM extends InMsg`.

### What this does not do

- **A name is still not an address.**  `self` is the only new way to become reachable; no
  lookup by name was added.
- **A reference that crosses between shapes is still declared by the receiver.**  A message
  field that may carry any process is `AnyProcess` (or a structural type naming what the
  receiver needs of it), and a concrete process is assigned to `AnyProcess` with a cast, as
  `children` already is.  That erasure belongs to the *receiver's declaration*; the context
  is where the shape is known, which is why `self` is not erased there.

## Tests

`src/self-reference.test.ts`:

1. `this.self` is the process the actor runs as — `isProcess`, the same `pname`/`id`, equal
   to `this.ctx.self`, and the same object the spawner got back.
2. A process hands itself to another and the holder sends through it: the message arrives
   with the *caller* as its sender, which is what `sendSelf` could not do.
3. `ctx.self` is on a plain async-generator process too, and addresses it.

## Consumers

Nothing downstream needs a change: the harness (email-agent) and the vendored services that
import posipaki typecheck clean against these types with no edits, which was measured before
the version bump.
