# Remote Actors

**Status:** draft

> **Note:** this replaces the earlier "Actor Process Isolation & Context
> Mobility" draft, which was written around FIFO child processes and used
> "host"/"child" naming. The primitive is unchanged — context mobility — but the
> topology is now stated as a **server/client** split, the layering is corrected
> (framing is a transport concern, not a protocol concern), and
> the layers below the glue are a stable interface rather than internals.

## Motivation

All actors currently run in a single Node process, but the architecture already
message-passes between actors. The remote-actor primitive is **context
mobility**: run a posipaki actor in any execution context that can speak a small
protocol, and let consumers treat local and remote identically.

That context can be a child process, a web worker, a different machine over
WebSocket, an SSH session, a sandbox. The actor doesn't know it's remote; the
consumer doesn't either.

## The model: a server/client split

A remote actor is a classic server/client pair speaking one protocol:

- **Server** — holds the real actor (`fn`, `setup`, handlers, and whatever
  storage the handlers close over). It serves the actor's state and messages.
- **Client** — holds a proxy. It connects to a server and drives the actor
  through it.

Messages flow both ways. `proc.send` on the client becomes `$msg` on the wire,
which the server dispatches to the actor's handler. The actor's `emit` becomes
`$msg` back, which the client delivers to the proxy's subscribers. State mirrors
server → client as `$state`.

The two endpoints are the two faces of **one seam** — the wire protocol. They are
mirror images, sit at the same distance above the transport, and version/evolve
**together**: any change to the frame vocabulary touches both sides at once.

> **Naming.** The current `src/remote/` names these backwards: `child.ts`
> (`runChild`) is the **server**, and `host.ts` (`spawnRemote`) is the
> **client**. This proposal renames them. We avoid location words — "frontend"/
> "backend" (breaks for workers, where both sides are in one browser) and
> "host"/"child" (breaks for non-process transports) — and use the role words
> server/client throughout.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│  glue       defineRemoteActor                 sugar          │
├──────────────────────────────────────────────────────────────┤
│  seam       serveRemoteActor · connectRemote  server/client  │
├──────────────────────────────────────────────────────────────┤
│  transport  FIFO · WebSocket · Worker         framing + ser  │
├──────────────────────────────────────────────────────────────┤
│  protocol   frame vocabulary + guards + version              │
└──────────────────────────────────────────────────────────────┘
```

Each rung is a stable interface, usable on its own. You don't have to climb to
the top.

| Layer | Owns |
| --- | --- |
| **Protocol** | The frame vocabulary (`$proto`/`$init`/`$state`/`$msg`/`$exit`), the type guards, and a version. **Object-shaped, not string-shaped.** |
| **Transport** | Framing + movement. How a byte stream is split back into frames and moved. |
| **Seam** | Two endpoints — `serveRemoteActor` (server) and `connectRemote` (client) — each pumps the protocol over a transport. |
| **Glue** | `defineRemoteActor` — the demoable sugar that wraps the client side into a normal actor. |

The protocol semantics do not change when the transport does.

## Protocol

The protocol is a set of **frame objects** — plain JS objects carrying a single
`$`-key each — plus the JSON encoding (`encode`/`decode`), type guards, and a
version string. It knows nothing about framing; that is the transport's business.

### Version

`PROTO_VERSION = "json.v1"` — names the *encoding* (JSON). The frame vocabulary
(the `$`-keys and their meaning) is fixed; the same frames could equally be
carried as `asn1.v1` or `protobuf.v1`. The version deliberately does **not** name
the *framing* — newlines, message boundaries — that is the transport's concern
(the old `"ndjson.v1"` conflated the two). The handshake checks encoding
compatibility and acts as the server's "I'm ready" signal.

### Frame vocabulary

Five frames, matching the implementation:

| Frame | Direction | Purpose |
| --- | --- | --- |
| `$proto` | server → client | version handshake, once on connect |
| `$init` | client → server | domain args + parent identity |
| `$state` | server → client | state snapshot (the first after `$init` signals ready) |
| `$msg` | bidirectional | a posipaki message crossing the boundary |
| `$exit` | server → client | graceful exit + final state |

Each frame is one object:

```json
{ "$proto": "json.v1" }
{ "$init": { "start": 0, "parentName": "host", "parentIdName": "host" } }
{ "$state": { "count": 1 } }
{ "$msg": { "fromName": "root", "body": { "type": "INCREMENT", "by": 1 } } }
{ "$exit": { "code": 0, "state": { "count": 42 } } }
```

The guards (`isProto`, `isInit`, `isState`, `isMsg`, `isExit`) operate on these
objects.

### Sender identity

`$msg` carries `fromName` plus the message body. On receipt the sender is
reconstructed as `{ fromName, fromId: Symbol() }` — a fresh symbol, because a
plain symbol can't survive serialization. Cross-boundary *message* identity is
therefore not preserved (a known shortcoming).

`$init` is different: `parentName`/`parentIdName` are `Symbol.for` names, so the
parent's identity *does* round-trip — both sides resolve the same global symbol
by name.

### Framing is **not** here

The earlier draft's `encode` did `JSON.stringify(...) + "\n"` in one step,
conflating encoding with framing. That was a bug:

- **Encoding** (JSON) is the protocol's job — `encode`/`decode` turn a frame
  object into a string and back, and the version names it (`json.v1`).
- **Framing** is how a byte stream is split back into discrete messages. It
  belongs to the transport — the transport is the thing that must split the
  stream.

So `encode`/`decode` stay in the protocol (JSON only, no `\n`); the transport
adds and strips the delimiter.

## Transport

```ts
interface Transport {
  send(frame: string): void | Promise<void>;
  onMessage(handler: (frame: string) => void): void;
  removeHandler(): void;
  close(): Promise<void>;
}
```

The transport moves **encoded frames** (JSON strings) and owns framing and
movement; the protocol's `encode`/`decode` sits above it.

| Transport | Framing | Client reaches the server by |
| --- | --- | --- |
| **FIFO** | newline (`\n`) | spawning the child and opening the fifo |
| **WebSocket** | native message boundary | connecting to `ws://` / upgrading a request |
| **Worker** | native message boundary | `new Worker(url)` |

FIFO and WebSocket both carry `json.v1` (JSON-encoded frames). The worker case is
different: `postMessage` structured-clones the frame object directly (no JSON),
so it is a distinct encoding and version — a future concern. The seam is
unchanged; only the transport and the spawner differ.

## The seam

### Server — `serveRemoteActor(fn, transport, { env })`

Serves one actor over an already-established transport:

1. send `$proto`
2. await `$init`, split domain args from parent identity
3. spawn `fn(args, env)`
4. bridge: transport-in → `actor.send`; `actor` emit → `$msg`/`$state`; on exit → `$exit`
5. close the transport

This is today's `runChild`, with the argv/FIFO bootstrap peeled off and the loop
extracted as `bridgeActor(fn, transport, { env })`.

### Client — `connectRemote(transport, opts) → RemoteProxy`

Connects to a server over an already-established transport:

1. await `$proto`, validate version
2. send `$init` (domain args + parent identity)
3. await first `$state` → `ready()`
4. pump `$state`/`$msg`/`$exit` into the proxy
5. return the proxy

This is today's `spawnRemote`, with the `mkfifo` + `spawn` bootstrap peeled off.

```ts
interface RemoteProxy<State, InMsg, OutMsg> {
  readonly state: State;
  ready(): Promise<void>;
  send(msg: InMsg): void;
  wait(): Promise<{ code: number | null; state: State }>;
  onMessage(handler: (msg: OutMsg) => void): void;
}
```

The two functions are the **same seam seen from two sides**, not two layers. They
must version together, because they share the protocol.

### Exit

| Scenario | What the client sees |
| --- | --- |
| server sends `$exit` | `$exit` frame, then close |
| clean close, no `$exit` | close code; `wait()` resolves `{ code, lastState }` |
| abrupt drop / SIGKILL | close; `wait()` resolves `{ code: null, lastState }` |

`STOP` works end-to-end: client `send({ type: "STOP" })` → server
`onStopRequested` → `$exit` → client `wait()` resolves.

## The glue — `defineRemoteActor`

The demoable sugar. It wraps an actor definition so spawning it runs it remote,
while the same module can also be the server entry point (today: a
`--remote=<pathhash>` argv marker). From the consumer's perspective, local and
remote spawn identically:

```ts
// one file, both ends
export const counterRemote = defineRemoteActor(CounterActor, import.meta.url);

// same call, same shape as a local actor
const proc = counterRemote.spawn(null)({ start: 0 });
await proc.ready();
proc.send({ type: "INCREMENT", by: 1 });
proc.state;
await proc.wait();
```

Under the hood it is just the client side of the seam wrapped as a normal actor
definition via `makeProxyDef`: `setup` connects and stashes `{ public:
remote.state, private: { remote } }`, `onMessage` forwards + stops propagation,
`onStopRequested` sends STOP and waits.

## `env` — execution context

`setup` gains a second parameter, threaded from the spawn site:

```ts
setup?: (
  this: ActorContext,
  args: Args,
  env: SetupEnv,
) => InternalState | Promise<InternalState>;
```

`spawnAsync(fn, name)(args, env)` → `start(args, env)` →
`setup.call(self, args, env)`.

- **args** — domain (what the actor operates on) — serialized in `$init`.
- **env** — execution context (where it runs: the socket, the request, the peer,
  the url) — local, never serialized, setup-only (handlers reach it via
  `this.state`).

This replaces smuggling context through args: the demo's `setup({ peer })`
becomes `setup(args, { peer })`.

## What changes in `src/remote/`

1. **Rename** server/client: `runChild` → `serveRemoteActor`, `spawnRemote` →
   `connectRemote`; `child.ts`/`host.ts` → `server.ts`/`client.ts`.
2. **Extract** the serve loop from `runChild`'s argv parsing →
   `bridgeActor(fn, transport, { env })`.
3. **Extract** the handshake + pump from `spawnRemote`'s mkfifo/spawn →
   `connectRemote(transport, opts)`.
4. **Introduce** the `Transport` interface; make `FifoUtf8NlineTransport`
   implement it.
5. **Slim** the protocol: drop `encode`/`decode`-to-string from the protocol
   (frame vocabulary + guards + version remain); byte transports own their JSON
   serialization.
6. **Thread `env`** through the spawn path (a core change, touching
   `process.async.ts` and `define-actor.ts`).
7. **Add** `WebSocketTransport` and a worker transport as `Transport`
   implementations (separate follow-up proposals).

## Out of scope

Process-isolation wrappers from the earlier draft (`withSudo`, `withBwrap`,
`withSsh`) are FIFO-transport concerns — they rewrite the spawn command — and are
not part of the transport-agnostic seam. They stay out of the general proposal.

## Open questions

- **Route naming on the server.** `serveRemoteActor` takes an already-established
  transport; mapping a WebSocket route to an actor name/`fn` stays in the
  consumer's court (or a small `name → fn` registry helper).
- **`parentName`/`parentIdName` for a multi-client server.** For one server, many
  clients, what identifies each connection?
- **`$fd` (stdout/stderr forwarding).** The earlier draft proposed a sixth frame
  for process output. Not implemented, and process-specific — likely belongs as
  a FIFO-transport extension, not a core frame.
