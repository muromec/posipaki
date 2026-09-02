# Actor Reflection RPC

**Status:** draft

## Summary

Add a generic reflection/RPC mechanism to `defineActor`. Actors can
expose named methods callable through `actor.$reflection.method()`.
For local actors, methods are invoked directly. For remote actors
(via `defineRemoteActor`), calls are translated to wire protocol
messages with request-response matching and timeouts.

## Motivation

Currently there is no way to inspect or interact with a running actor
from outside its message handlers. The persona (or operator) can't ask
"what children do you have?", "what's your state?", or "please stop."
All interaction must go through the message dispatch loop.

Reflection methods provide a side-channel for introspection and
control — discoverable, typed, and available both locally and across
process boundaries.

Concrete use cases:

- **Process tree introspection**: walk the actor tree, show hierarchy
- **State inspection**: read an actor's current state for debugging
- **Health checks**: ping actors, check uptime, detect stuck processes
- **Graceful shutdown**: stop a specific actor without killing the tree

## Design

### defineActor config

`defineActor` gets a new optional field `$reflectionMethods`:

```ts
const actor = defineActor({
  $reflectionMethods: {
    ping: () => 'pong',
    getStatus(): { uptime: number } {
      return { uptime: Date.now() - this.state.startedAt };
    },
  },
  handlers: { ... },
});
```

Methods have access to `this` (the ActorContext) — same as handlers
and lifecycle hooks.

### Plugin API

Plugins register reflection methods via `ctx.registerMethod()`:

```ts
const myPlugin: ActorPlugin = {
  name: "myPlugin",
  install(ctx) {
    ctx.registerMethod("ping", () => "pong");
    ctx.registerMethod("stop", () => ctx.agreeToStop());
  },
};
```

This follows the same pattern as `ctx.onMessage()`, `ctx.onEmit()`,
`ctx.decorate()` — a registration point on the actor context available
during plugin `install()`.

### $reflection namespace

Both sources (config + plugins) merge into `actor.$reflection`:

```ts
const proc = actor.spawn(args);

// Call reflection methods
const status = await proc.$reflection.getStatus();
await proc.$reflection.stop();
```

The `$reflection` proxy is lazy — it intercepts property access and
either invokes the method directly (local actor) or sends a wire
message (remote actor).

### Wire protocol

Three new message types in the `$reflect` namespace:

```
$reflect.method  { id: number, method: string, args?: unknown[] }
$reflect.result  { id: number, data: unknown }
$reflect.error   { id: number, message: string, code?: string }
```

**Request-response matching**: each `$reflect.method` carries a
monotonically increasing `id` (per connection). The corresponding
`$reflect.result` or `$reflect.error` carries the same `id`. The
caller keeps a `Map<number, PromiseResolver>` and resolves when the
matching response arrives.

**Timeouts**: if no response arrives within a configurable timeout
(default 5 seconds), the promise rejects with a synthetic
`$reflect.error { code: 'timeout' }`.

**Auto-rejection**: if the remote doesn't recognize the method (no
handler registered), the protocol layer replies with:

```
$reflect.error { id, message: 'unknown method: <name>', code: 'unknown_method' }
```

No silent drops, no hanging promises.

### Capability advertisement

During `$proto` handshake, each side advertises its available methods:

```json
{
  "proto": "posipaki-1",
  "plugins": ["treeIntrospection"],
  "methods": ["getTree", "getState", "stop"]
}
```

The host can check `methods` before calling — avoid sending
`$reflect.method` to actors that won't respond.

### Remote connector integration

**Host side** (`host.ts`): `RemoteProxy.$reflection` intercepts method
calls, assigns an `id`, sends `$reflect.method` over the wire, returns
a promise that resolves on `$reflect.result` or rejects on
`$reflect.error`/timeout.

**Child side** (`child.ts`): the wire protocol layer receives
`$reflect.method`, looks up the method in the registered handlers,
invokes it, sends `$reflect.result` with the return value or
`$reflect.error` if the method throws or is unknown.

### TypeScript

Methods are typed — `$reflection` carries the union of all registered
method signatures:

```ts
type ReflectionOf<T extends ActorDefinition<...>> = {
  [K in keyof T['config']['$reflectionMethods']]:
    T['config']['$reflectionMethods'][K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<R>
      : never;
};
```

Plugin-registered methods can't be statically typed (they're dynamic),
but `$reflection` is typed as `Record<string, (...args: any[]) => Promise<unknown>>`
for the dynamic portion.

## Implementation plan

1. Add `$reflectionMethods` to `ActorConfig` type
2. Build the `$reflection` proxy on `AsyncProcess` — intercepts property access
3. Add `ctx.registerMethod()` to `ActorContext`
4. Merge config methods + plugin methods into the handler map
5. Add `$reflect.method`/`$reflect.result`/`$reflect.error` to the wire protocol
6. Integrate into `host.ts` (RemoteProxy) and `child.ts` (runChild)
7. Add capability advertisement to `$proto` handshake
8. TypeScript: type inference for config-defined methods
9. Tests: local invocation, plugin registration, wire round-trip, timeout, unknown method

## Open questions

- **Should `$reflection` return `Promise` always?** Yes — keeps the
  API uniform. Local calls resolve synchronously but still return
  a Promise.
- **Should method args be serializable?** Yes — same constraints as
  wire messages. JSON-serializable only for remote calls.
- **Should there be a way to list available methods at runtime?**
  `actor.$reflection.$methods()` could return the registered method
  names. Useful before calling.
- **Error propagation?** If a method throws, the error message is sent
  as `$reflect.error` with `code: 'method_error'`. The original stack
  trace is lost across the wire (by design — different process).

## Related

- [Remote Actors](actor-remote.md)
- [Actor Plugin System](actor-plugin-system.md)
- [defineActor Proposal](define-actor-proposal.md)
