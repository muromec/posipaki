# WebSocket transport for remote actors

**Status:** draft
**Follows:** [actor-remote.md](./actor-remote.md)

## Motivation

The remote-actor proposal established **context mobility** as the primitive: run a
posipaki actor in any execution context that speaks a small wire protocol, and let
the consumer treat local and remote identically. It named FIFO as the first
transport and sketched `TcpTransport` / `UdpTransport` as future slots under the
same protocol semantics.

This proposal adds **WebSocket** as the next transport. WebSocket is the only
bidirectional message transport a browser can speak natively, which extends the
remote-actor model from local child processes to browser and edge contexts. It
also gives the transport a clean split — a *client* side (connect to `ws://`) and
a *server* side (upgrade an incoming request) — both carrying the same frames.

## Direction

Working backwards from the consumer API fixes the shape:

- **Backend** is the **served** side. It holds the real actor — `setup`, handlers,
  and whatever storage the handlers close over. It accepts a websocket connection
  and bridges the actor to it.
- **Frontend** is the **connecting** side. It holds only the message contract, not
  the actor. It spawns a proxy, and that proxy talks to the backend over the
  websocket.

Messages flow: `proc.send` on the frontend → `$msg` over the wire → the backend
actor's handler. The backend actor's `emit` → `$msg` back → the frontend's
`proc` subscription. State mirrors the same way, backend → frontend, as `$state`.

## Current state (what is implemented)

`src/remote/` today:

| File | Role |
| --- | --- |
| `protocol.ts` | NDJSON wire format (`ndjson.v1`): `$proto` `$init` `$state` `$msg` `$exit`, plus `encode`/`decode` and type guards |
| `fifo.ts` | `FifoUtf8NlineTransport` — newline-delimited UTF-8 over two named FIFOs |
| `child.ts` | `runChild(fn)` — served side: reads `--fifo-in/--fifo-out`, handshakes, spawns the actor, bridges |
| `host.ts` | `spawnRemote`/`commandConnector` — connecting side: spawns the child process, handshakes, returns `RemoteProxy` |
| `define.ts` | `defineRemoteActor(actor, url, opts)` — wraps an actor so spawning it runs it remote |

The host/child contract is deliberately small:

```ts
interface RemoteProxy<State, InMsg, OutMsg> {
  readonly state: State;
  ready(): Promise<void>;
  send(msg: InMsg): void;
  wait(): Promise<{ code: number | null; state: State }>;
  onMessage(handler: (msg: OutMsg) => void): void;
}

type Connector = (opts: CommandSpawnOptions) => Promise<RemoteProxy<...>>;
```

The proxy actor built by `defineRemoteActor` touches nothing but
`connect(opts)` / `remote.send` / `remote.onMessage` / `remote.state` /
`remote.wait`. It has no idea FIFOs or child processes exist. The wire protocol
is pure NDJSON and equally transport-agnostic. The FIFO-ness is confined to two
places: `spawnRemote` (host bootstrap) and the argv parsing in `runChild` (child
bootstrap).

Two facts matter for the frontend/backend split:

- **The message contract is compile-time only.** `defineMessages<T>()` returns
  `undefined` at runtime and `ActorMessages<M>` is a phantom type
  (`{ __tag_messages: M }`). The only runtime value in a contract is the actor
  `name` string.
- Because the contract is type-only, the frontend can share the contract with a
  plain `import type` and never load the actor module — so server-side storage
  and handler logic cannot leak into the frontend bundle by construction.

What is **not** transport-agnostic yet:

1. `CommandSpawnOptions` hardcodes `command: string[]` — a websocket connector
   needs a `url` instead.
2. `runChild` hardcodes argv-based FIFO path discovery.
3. `defineRemoteActor` hardcodes `fileURLToPath(url)` plus a `--remote=<pathhash>`
   argv marker for `isRemoteRoot` detection — a process-specific mechanism that
   does not transfer to a served websocket route.

## The contract

A single shared module carries the message types and the actor name. It imports
nothing but `posipaki` types, so it is safe to load on both sides:

```ts
// contract.ts
export type CounterIn  = { type: "INCREMENT"; by: number } | { type: "DECREMENT"; by: number };
export type CounterOut = { type: "COUNT_CHANGED"; count: number };

export type CounterArgs  = { start: number };
export type CounterState = { count: number };

export const COUNTER_ACTOR_NAME = "counter";
```

## Setup environment

`setup` gains a second positional parameter — the environment:

```ts
setup?: (
  this: ActorContext<...>,
  args: Args,
  env: SetupEnv,
) => InternalState | Promise<InternalState>;
```

`env` is a plain object threaded from the spawn site:
`spawnAsync(fn, name)(args, env)` → `start(args, env)` →
`setup.call(self, args, env)`. Two properties define it:

- **Local, never serialized.** `$init` carries domain args + parent identity over
  the wire; `env` never crosses it. It is the execution context of *this*
  process — which socket, which request, which remote handle.
- **Setup-only.** Handlers reach it through `this.state` (stash it in `setup`),
  so there is no second ambient channel.

The split this formalizes:

- **args** = domain (what the actor operates on) → serialized in `$init`.
- **env** = execution context (where it runs) → local.

It also replaces an informal pattern already in use: the current demo does
`setup({ peer })`, smuggling `peer` through args. With env it is
`setup(args, { peer })`, and args stay domain-only. `env` is not a plugin
concern — plugins mutate config; env is a runtime parameter.

## API

```ts
// ── backend: full actor + storage, served over an upgraded socket ──
import { defineActor } from "posipaki";
import { serveRemoteActor } from "posipaki/remote";
import { Store } from "./store.js";
import * as C from "./contract.js";

export const CounterActor = defineActor<
  C.CounterArgs, C.CounterState, C.CounterIn, C.CounterOut
>({
  name: C.COUNTER_ACTOR_NAME,
  setup(args, env) {
    return { store: new Store(args.start), peer: env.peer };
  },
  handlers: { /* INCREMENT / DECREMENT → store + emit, reply via this.state.peer */ },
});

// wherever the websocket upgrade happens:
serveRemoteActor(CounterActor.fn, ws, { env: { peer, request } });
```

```ts
// ── frontend: contract only, spawns a live proxy ──
import { remoteClient } from "posipaki/remote";
import * as C from "./contract.js";

const Counter = remoteClient<
  C.CounterArgs, C.CounterState, C.CounterIn, C.CounterOut
>({
  name: C.COUNTER_ACTOR_NAME,
  url: (args) => `wss://${host}/counter/${args.scope}`,
});

const proc = await Counter.spawn({ start: 0 });
proc.send({ type: "INCREMENT", by: 1 }); // → $msg → backend actor
proc.state;                              // live-mirrors backend $state
await proc.wait();
```

`remoteClient(...).spawn()` yields a normal `AsyncProcess`, so the frontend
experience is identical to a local actor. The `url` option is either a string or
a factory `(args, name) => string` — the factory gets the spawn args and the
process name, so one contract serves many endpoints.

## What this needs

Three artifacts, each in its natural home.

### 1. `env` — spawn-time setup parameter (core change)

Thread a third value through the spawn path: `spawnAsync(fn, name)(args, env)`
→ `proc.start(args, env)` → generator `(ctx, args, env)` →
`setup.call(self, args, env)`. Mechanical and orthogonal, but it touches
`process.async.ts` and `define-actor.ts`, not just `remote/`. No plugin
involvement.

### 2. The proxy — config transform + factory

`makeProxyDef(contract, connect)` builds the proxy config: replace `setup` with
connect-and-stash (`{ public: remote.state, private: { remote } }`), add
`onMessage` forward + `stopPropagation`, add `onStopRequested` STOP+wait. It is
a config transform, and it has two call shapes:

- **factory** `remoteClient(contract, opts)` — for the frontend, which has only
  a contract (no fn). `opts.url: string | ((args, name) => string)`; the proxy's
  `setup` resolves the url and connects.
- **plugin** `remote({ connector })` — the same transform wrapped as a config
  plugin, for when there is already a config to wrap.

`defineRemoteActor` (host spawns a child) stays a **pair** — `makeProxyDef(...)`
for the host side plus the untouched original `fn` for `runChild` — because a
plugin runs inside `defineActor` before `makeRuntime` and cannot both replace the
config and hand the original fn back out.

### 3. `bridgeActor(fn, transport, { env })` — the serve loop

The runtime half: spawn `fn` with `env`, run the handshake, and pump
`$msg`/`$state`/`$exit` over the transport (extracted from `runChild`).
`serveRemoteActor(fn, ws, { env })` is the thin convenience over it:
`bridgeActor(fn, new WebSocketTransport(ws), { env })`.

### Supporting transport pieces

- **Wire protocol** — exists (`protocol.ts`). Generic, unchanged.
- **`WebSocketTransport`** — adapter exposing
  `send` / `onMessage` / `removeHandler` / `close` over a WS socket, one JSON
  object per frame.
- **`wsConnector(url)`** — client connector over the platform `WebSocket`, with
  the handshake + `RemoteProxy` construction extracted from `spawnRemote` into
  `bridgeRemote(transport, opts)`.

## Wire framing

One websocket frame = one protocol object (`JSON.stringify({ [key]: value })`,
no trailing newline). `$proto`, `$init`, `$state`, `$msg`, `$exit` all reuse
`encode`/`decode` unchanged. Exit semantics mirror the FIFO proposal's exit
table:

| Scenario | What the host sees |
| --- | --- |
| child sends `$exit` | `$exit` frame, then socket closes |
| clean close, no `$exit` | close code, `wait()` resolves with `{ code, lastState }` |
| abrupt drop | `error`/close with `1006`, `wait()` resolves with `{ code: null, lastState }` |

`STOP` still works end-to-end: host `send({ type: "STOP" })` → child
`onStopRequested` → `$exit` → host `wait()` resolves.

## Decisions & open questions

1. **URL factory** — resolved: `url` accepts `string | ((args, name) => string)`,
   so one contract serves many endpoints.
2. **env scope** — resolved: setup-only; handlers reach it via `this.state`.
3. **Who names the ws route.** `serveRemoteActor` only takes an already-upgraded
   socket; the HTTP layer (route → actor mapping) stays in the consumer's court.
   Confirm that boundary, or add a small helper that registers `name → fn` and
   upgrades by name.
4. **`parentName`/`parentIdName` in `$init`.** For a multi-client server, what
   should these be — connection id, endpoint name? They feed the child's identity
   symbol and need a decision for the server-side case.
5. **Order of work.** The `env` param and `bridgeActor`/`bridgeRemote` extraction
   are prerequisites. Suggested: `env` threading + `bridgeActor`/`bridgeRemote`
   refactor + `WebSocketTransport` first (pure refactor, no behavior change),
   then `serveRemoteActor`, then `wsConnector`/`remoteClient`/`makeProxyDef`.
6. **Reconnect / backpressure.** Out of scope for v1; the FIFO connector has
   neither, and parity is fine. Flag in the API docs.
7. **State semantics over ws.** Keep the mutable-shared-object `Object.assign` on
   `$state` (today's behavior) so the proxy actor's `this.state.public` stays
   live. No per-key deltas in v1.
8. **Code location.** `src/remote/ws.ts` (transport adapter + `wsConnector` +
   `serveRemoteActor` + `remoteClient`), plus the `bridgeActor`/`bridgeRemote`/
   `makeProxyDef` extractions into `child.ts`/`host.ts`/`define.ts` or a new
   `bridge.ts`. Testable headlessly with an in-process ws server/client pair,
   mirroring `host.test.ts`/`child.test.ts`.
