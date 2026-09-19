# Actor Reflection RPC

**Status:** increments 1, 2a (process references both ways), 2b (addressing a
process by its reference), 2c (a handle on a process the far side holds) and 2d (a
process of this side passed to the far one, and dispatched from there) are
implemented.  What a handle still cannot do — `wait`, `stop`, `pause`, `release` —
is listed below.

## Summary

`defineActor` actors expose named methods through `actor.$reflection.method()`,
reachable from outside the message loop. Locally a method is invoked and its
value wrapped; behind a wire the call is a frame and the answer is a frame. A
call reads the same in both cases: it answers with a promise.

## Motivation

There is no way to inspect or drive a running actor from outside its message
handlers. The persona (or an operator) cannot ask "what children do you have?",
"what is your state?", or "please stop" without a message type per question, and
none of that survives a process boundary at all.

Concrete use cases:

- **Process tree introspection**: walk the actor tree, show hierarchy
- **State inspection**: read an actor's current state for debugging
- **Health checks**: ping actors, check uptime, detect stuck processes
- **Graceful shutdown**: stop a specific actor without killing the tree

## Design

### defineActor config

`defineActor` takes `$reflectionMethods`:

```ts
const actor = defineActor({
  $reflectionMethods: {
    ping: () => "pong",
    getStatus(): { uptime: number } {
      return { uptime: Date.now() - this.state.startedAt };
    },
  },
  handlers: { ... },
});
```

Methods have access to `this` (the `ActorContext`) — the same `this` handlers and
lifecycle hooks get.

### Plugin API

Plugins contribute methods through `mergeConfigs`, so a plugin's names live in
its own namespace:

```ts
const myPlugin: ActorPlugin = async (config) =>
  mergeConfigs(config, {
    $reflectionMethods: {
      ...config.$reflectionMethods,
      "myPlugin.ping": async function () {
        return "pong";
      },
    },
  });
```

### `$reflection`

Both sources merge into the process handle's `$reflection`:

```ts
const proc = await actor.spawn(args);
const status = await proc.$reflection.getStatus();
await proc.$reflection.stop();
```

Every method is async, and that is enforced by type rather than by convention:
`ReflectionMethod` is `(...args: never[]) => Promise<unknown>`,
`ReflectionOptions` is an index signature over it, and `ActorReflection`
extends `ReflectionOptions` — so a method declared `() => number` does not
compile. The parameters are `never` because nothing is called *through* the
type; it exists to check what a method is written as.

`defineActor` wraps each method so that whatever it returns reaches the caller as
a promise (see Implementation 4).

### Wire protocol

Three frames, in the `$r` family:

```
{"$r.methods": ["inspect.getTree", …]}     server → client, once
{"$r.call.<name>": {seq, args}}            client → server
{"$r.result.<name>": {seq, value}}         server → client
{"$r.result.<name>": {seq, error}}         server → client
```

The method name is in the frame key, so a frame says what it is without a table.

**Request-response matching**: `seq` belongs to one connection and is never
reused. The answer carries the `seq` of the call it belongs to, so two calls to
the same method in flight at once stay apart, and answers may come back in any
order. The caller keeps a `Map<number, …>` and settles the matching promise.

**Unknown method**: a name the server never announced is answered with
`{seq, error}` — the announced list *is* the dispatch table, so no frame can
reach a property the actor did not offer.

**Refused results**: a method that throws, and a result that cannot cross a frame
(a function, a symbol, a bigint, a value with a cycle), are answered with
`{seq, error}` rather than half-written.

**No deadline.** A call that is never answered fails when the wire closes; a
configured timeout was considered and left out of scope. The transport already
reports a peer that is gone, and a deadline would have to tell "slow" from
"gone" without knowing which the far side is.

### Capability advertisement

The server announces what it can answer — `{"$r.methods": [names]}` — once, after
its actor is ready and before the first `$state`. The client installs one
function per announced name on `$reflection`; a name that is never announced is
never callable, so a peer that announces nothing simply has no methods.

It cannot ride the `$proto` handshake: the spawner performs that one, and a
spawner has no actor — nothing to ask about what can be answered. The list is
computed after `spawn()`, which is also the first moment it is true.

### Process references

A process is not JSON, so a method that returns one answers with a reference:

```
{"$p": {"id": 3, "pname": "main:worker"}}
```

- Ids belong to a connection and to the side that holds the process. One per
  process — handed over twice, it is the same id both times — monotonic, and
  never reused, so a stale reference cannot come to mean another process.
- Ids start at 1. Id 0 is the connection's own root, bound on both sides — the far
  actor on one, the proxy that asked for it on the other — and never handed to
  another process.
- Containers are copied, never rewritten: the state an actor is still running on
  is not the wire's to edit.
- Both sides parse references: a result on the caller's side, an argument on the
  answerer's. Parsing gives a handle on that process — the name, the id, and the
  connection to reach it on. A reference sent back travels as the id it came with.

What makes a value a process is judged by what it holds, not by `instanceof`: a
build inlines its own copy of `AsyncProcess` per entry point, so a process built
by `posipaki` is not an instance of the class inside `posipaki/remote`.

### Addressing a process — done (2b)

A frame that is about a process says so at the top level, beside its payload rather
than inside it: the payload of a `$state` *is* the state, which a `to` inside it
would sit in the way of.

```
{"to": 3, "$msg": {"fromName": "main", "body": {"type": "PING"}}}
{"to": 3, "$r.call.probe.add": {"seq": 1, "args": [1, 2]}}
{"$msg": {"fromName": "main", "body": …}}          no address: the root
```

- A frame that names no process is for the root of the connection, which is what
  every frame meant before there were ids at all. Root traffic is therefore
  unchanged on the wire: `to` is written only when it names something else.
- Each side keeps one table for the connection — id → the process it knows by that
  id, with its own root bound at 0. It is what a frame arriving with an id resolves
  against, and what a frame leaving with a process in it looks that process up in.
  A side numbers the processes it holds; an id is allocated the first time one
  crosses, and never reused.
- Every frame is walked once on the way out (processes → references) and once on
  the way in (references → what this side knows). One rule per frame, not one per
  payload kind: a process on the state, in a message body, in a call argument or in
  a result is the same walk, and handing another process over needs no new code.
- A frame addressed to an id the table does not hold has nothing to deliver it to
  and is dropped; a call addressed that way is answered with an error rather than
  left hanging.
- Only what a process announced can be called: the announced list is the dispatch
  table, and a process that has not announced anything answers nothing.

### A handle — done (2c)

A reference this side receives is a process it can talk to: `RemoteProcess`, one
per process per connection.

```ts
const kid = proc.state.kid;          // RemoteProcess
kid.pname;                           // "remote:kid"
kid.ref.id;                          // 2 — the id this connection knows it by
kid.isConnected();                   // false once the connection is gone
kid.state;                           // what the far side has published so far
kid.$reflection["inspect.getTree"];  // what it announced it can answer
kid.send({ type: "PING" });           // a message for it
kid.subscribe("message", (msg) => …); // what it says
kid.subscribe("state", () => …);      // what it holds
```

- A process that crosses is announced and streamed from that moment: what it can
  answer, the state it holds, and what it emits.  The stream starts after the
  frame that carried the reference, so a handle is named before it hears anything,
  and the entry that carried it needs no code of its own.
- A handle is not a node in this side's tree.  Asking the proxy for the tree walks
  the far side and gives that tree; a handle is how a process there is talked to,
  not where it sits here.
- A reference handed back to the side that holds the process is that process
  again, not a handle on itself.
- A handle does not outlive its connection: when the wire goes, every handle on
  it says so, and a `send` after that throws rather than disappearing.  There is
  no reconnect to wait for, so nothing pretends there might be.

### A process of this side's — done (2d)

The same reference works the other way. A process this side holds goes over as an
argument or in a message body, is numbered here, and is a handle on the other side:

```ts
await surface["probe.poke"](myChild);   // myChild is numbered 1 here, and a handle there
```

- It needs no code of its own: what crosses is one walk, in both directions, so a
  process handed *out* is the same walk as one handed back.
- A process this side hands over is streamed from that moment, exactly as the far
  side streams its own — what it can answer, the state it holds, and what it emits,
  each frame addressed with the id it crossed by. The side that holds a process is
  the side that says what it holds, so a `$state` frame for a process of this
  side's own is ignored here and lands on the handle there.
- A message addressed to that id is delivered into the process where it lives, and
  what that process does about it crosses back on its stream — which is how a
  `send` on a handle is answered rather than merely delivered.
- The wire carries a sender as a name, since a symbol cannot be written down. A
  side turns the name back into a sender, and uses the parent's stable id when the
  name is the one the receiving process was told is its parent.
- A method call *into* a process this side holds is not answered yet: the
  announcement arrives, and the call side of it is 2f.

What is left for 2e and after: a process of this side's own passed to the far one
and dispatched from there (2d), handles in messages, arguments and state updates
(2e), `wait`, `stop`, `pause` and subscriptions both ways (2f), orphans (2g), and
`release()` with `isConnected()` as the one answer about liveness (2h), and method
calls from the far side into a process this side holds, both ways for `subscribe`
and `wait`.  Stopping
is where the root differs and keeps what it does today: asking the root to stop
is the STOP message plus the far side's exit, while stopping any other process is
a frame of its own (`$stop`, with `$pause` and `$resume` beside it).

### TypeScript

Config-defined methods are typed from the config; plugin methods through
declaration merging on `ActorReflection`. Both are held to the async contract:

```ts
declare module "posipaki" {
  interface ActorReflection {
    "myPlugin.getCount": () => Promise<number>;
  }
}
```

## Implementation plan

1. `$reflectionMethods` in `ActorConfig` — done
2. `$reflection` on the process, filled by `defineActor` — done, one object with
   the context's own `reflection`
3. Plugin registration — done through `mergeConfigs`
4. Method wrapping, so a call answers with a promise — done
5. Wire frames — done, as `$r.call.<name>` / `$r.result.<name>`
6. The seam (`client.ts` / `server.ts`) — done
7. Capability advertisement — done, as `$r.methods` before the first `$state`
8. Process references, both directions — done (2a)
9. Addressing a process by reference — done (2b): the connection's table, `to` on
   the frames that name a process, and one walk per frame in each direction
10. A handle a caller can use — done (2c): `send`, `state`, `subscribe`,
    `$reflection` and `isConnected()`; `wait`, `stop`, `pause` and `release()`
    follow
11. A process of this side's passed to the far one, and dispatched from there —
    done (2d): the same table, reference and stream, used from the other end
12. Tests: local invocation, plugin registration, wire round-trip, concurrent
    calls, refusals, references over a real subprocess — done; and every carrier
    of a reference — a message body, a call argument, a state update that replaces
    one process with another — tested in both directions (2e)

## Open questions

- **Should `$reflection` return `Promise` always?** Yes, and it does — the type
  contract requires it, so a local call and a call over a wire are read the same
  way.
- **Should method args be serializable?** Yes: what crosses is JSON, plus
  references to processes. Anything else is refused before it is written, rather
  than dropped by the encoder.
- **Should there be a way to list available methods at runtime?**
  `$reflection.$methods()` could answer with the announced names. The client
  keeps the list; it is not exposed.
- **Error propagation?** A method's own message crosses; the stack does not
  (different process). The wire carries a message, not a code: a caller that
  wants codes has to read the message or the framework has to classify.

## Related

- [Remote Actors](actor-remote.md)
- [Actor Plugin System](actor-plugin-system.md)
- [defineActor Proposal](define-actor-proposal.md)
- [Migration: reflection methods are async](../migration/reflection-methods-are-async.md)
