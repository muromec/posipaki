# posipaki: the reactor as an actor

> **Status**: Draft proposal, written down while `server-reactor.md` is the one being built.  Nothing here is
> needed for that proposal; it is out of scope on purpose.

## Summary

The reactor serves from a plain handle: `reactor(listener, factory, { onSession, onClosed })`, with callbacks
and a `stop()`.  A consumer that is itself an actor wants the same thing in its own vocabulary: the listener
owned by the actor, the reports arriving as messages so state changes in a handler, and `STOP` as the stop.

```ts
const Service = defineActor({
  async afterStart() {
    this.state.reactor = reactor(this.state.listener, (connection) => makeSession(this.self), {
      onSession: ({ proc, meta }) => this.emit({ type: "SESSION_OPENED", session: proc, meta }),
      onClosed: ({ proc }) => this.emit({ type: "SESSION_CLOSED", session: proc }),
    });
  },
  beforeEnd() {
    return this.state.reactor?.stop();
  },
  handlers: {
    SESSION_OPENED(msg) {
      this.state.attached.push(msg.session);
    },
    SESSION_CLOSED(msg) {
      this.state.attached = this.state.attached.filter((session) => session !== msg.session);
    },
  },
});
```

The wrapper holds an `afterStart` that builds the reactor from a listener and a factory, a `beforeEnd` that
stops it, and a default that turns the two callbacks into two out-messages, and nothing else.

## What it buys

- **State changes in a handler.**  Every actor here already keeps its state in handlers; the callbacks of the
  plain reactor run beside that loop, and a consumer with a list (what is attached, what is being served) has
  to get back into it.  Messages are already the way that is done.
- **One lifetime for the listener.**  `afterStart` binds it, `beforeEnd` stops the reactor, and a restart of
  the actor is a restart of the listener.  The plain handle leaves that pairing to the consumer, and a
  consumer that forgets the `stop()` leaves a socket file and a pending accept behind.
- **Policy stays in the actor.**  The actor can refuse a session it does not want, or keep a list, while the
  reactor stays a reporting piece.

## What it does not buy yet

**The sessions are not its children.**  `serveRemoteActor` spawns the actor it serves with `actor.spawn`,
which is a root process, so a session appears in the tree as its own root rather than under the actor serving
it.  Making them children needs the primitive `server-reactor.md` names as missing: serving a *running*
process, or a serve that takes a fork site.  That primitive is worth its own proposal, and it is the same one
that would let a long-lived actor be served directly rather than through a per-connection session.

## Open

- **The name and the shape**: a function returning an actor definition from a listener and a factory
  (`reactorActor`), or a helper the consumer spreads into its own setup.
- **Where the reports go by default**: out-messages to the parent, as above, or a target given at build time.
- **Whether the sessions should become children**, and therefore whether the serve-a-running-process primitive
  comes before this wrapper or after it.
