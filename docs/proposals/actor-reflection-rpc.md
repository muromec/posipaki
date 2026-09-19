# Actor Reflection RPC

**Status:** increment 1 (calling reflection methods over the seam), increment 2a
(process references both ways) and increment 2b (addressing a process by its
reference) are implemented; a handle a caller can use — 2c — is not.

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
  answerer's. Parsing gives an `UnreachableRemoteProcess` — the id and the name,
  and no way to reach it. A reference sent back travels as the id it came with.

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

What is left for 2c and after: a parsed reference still has no way to reach the
process it names, so a handle — something with `send`, `wait`, `stop`, `pause` and
a subscription — is what 2c adds, and a released or dropped one rejects and throws
rather than waiting for a reconnect that does not exist. Stopping is where the root
differs and keeps what it does today: asking the root to stop is the STOP message
plus the far side's exit, while stopping any other process is a frame of its own
(`$stop`, with `$pause` and `$resume` beside it). A handle does not need a node in
the local tree: `getTree` is already proxied, so asking the proxy walks the far
side's tree, and that is the tree.

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
10. A handle a caller can use — pending (2c): `send`, `wait`, `stop`, `pause`,
    subscription, `release()` and `isConnected()`
11. Tests: local invocation, plugin registration, wire round-trip, concurrent
    calls, refusals, references over a real subprocess — done

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
