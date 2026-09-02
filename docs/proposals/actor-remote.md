# Remote Actors

**Status:** Implemented

The primitive is **context mobility**: run a posipaki actor in any execution
context that can speak a small protocol, and let consumers treat local and
remote identically. The actor doesn't know it's remote; the consumer doesn't
either.

## Motivation

Actors message-pass in a single process, but the runtime is already
transport-agnostic about *who* a message goes to. The remote-actor primitive
moves an actor's inbox and outbox across a boundary — a child process, a web
worker, a different machine over WebSocket, an SSH session, a sandbox — while
the actor's `setup`, handlers, and storage stay in the **server** and a thin
**client** proxy stands in for it locally.

## The model: a server/client split

A remote actor is a server/client pair speaking one protocol:

- **Server** — holds the real actor (`setup`, handlers, and whatever storage the
  handlers close over). It serves the actor's state and messages.
- **Client** — holds a proxy. It connects to a server and drives the actor
  through it.

Messages flow both ways. `proc.send` on the client becomes `$msg` on the wire,
which the server dispatches to the actor's handler. The actor's `emit` becomes
`$msg` back, which the client delivers to the proxy's subscribers. State mirrors
server → client as `$state`.

The two endpoints are the two faces of **one seam** — the wire protocol. They
are mirror images, sit at the same distance above the transport, and
version/evolve **together**: any change to the frame vocabulary touches both
sides at once.

> **Naming.** The roles are named by what they *do*, not where they live:
> `server` (serves the actor) and `client` (drives a proxy). Location words are
> avoided — "frontend"/"backend" breaks for workers (both sides in one browser),
> "host"/"child" breaks for non-process transports.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│  glue       defineSubprocessActor               sugar        │
├──────────────────────────────────────────────────────────────┤
│  seam       serveRemoteActor · remoteClient     server/client│
├──────────────────────────────────────────────────────────────┤
│  channel    Channel · StringTransport · guards  frame vocab  │
├──────────────────────────────────────────────────────────────┤
│  transport  FIFO · WebSocket · Worker           framing      │
├──────────────────────────────────────────────────────────────┤
│  protocol   json1 (json.v1) · clone (clone.v1)  encoding     │
└──────────────────────────────────────────────────────────────┘
```

| Layer | Files | Owns |
| --- | --- | --- |
| **Protocol** | `protocols/json1.ts` | JSON `encode`/`decode` + the version string (`json.v1`). The worker's structured-clone encoding (`clone.v1`) has no JSON and lives in its transport. |
| **Channel** | `channel.ts` | `Channel` (frame objects), `StringTransport` (frame strings), and the frame guards. This is the seam's shared vocabulary. |
| **Transport** | `transports/*.ts` | Framing + movement. FIFO and WebSocket move encoded strings; Worker moves frame objects directly. |
| **Spawner** | `spawners/*.ts` | Environment bootstrap: how a transport is *obtained* on each side, plus the `$proto` handshake. |
| **Seam** | `server.ts`, `client.ts` | `serveRemoteActor` / `remoteClient` — pump frames over a `Channel`. |
| **Glue** | `define-subprocess.ts` | `defineSubprocessActor` — wrap the client side as a normal actor definition. |

Each rung is a stable interface, usable on its own. You don't have to climb to
the top, and the seam never sees a specific protocol, transport, or spawner.

## Protocol

The protocol is a set of **frame objects** — plain JS objects carrying a single
`$`-key each. It knows nothing about framing; that is the transport's business.

### Version

The version names the *encoding*, not the framing.

- `VERSION = "json.v1"` — JSON encoding (`protocols/json1.ts`). The frame
  vocabulary is fixed; the same frames could equally be carried as
  `asn1.v1` or `protobuf.v1`.
- `WORKER_VERSION = "clone.v1"` — structured clone, the worker's native
  `postMessage` encoding. No JSON round-trip; the transport moves frame objects
  as-is.

The handshake checks encoding compatibility and acts as the server's "I'm
ready" signal.

### Frame vocabulary

Five frames:

| Frame | Direction | Purpose |
| --- | --- | --- |
| `$proto` | server → client | version handshake, once on connect |
| `$init` | client → server | domain args + parent identity |
| `$state` | server → client | state snapshot (the first after `$init` signals ready) |
| `$msg` | bidirectional | a posipaki message crossing the boundary |
| `$exit` | server → client | graceful exit + final state |

```json
{ "$proto": "json.v1" }
{ "$init": { "start": 0, "parentName": "host", "parentIdName": "host" } }
{ "$state": { "count": 1 } }
{ "$msg": { "fromName": "root", "body": { "type": "INCREMENT", "by": 1 } } }
{ "$exit": { "code": 0, "state": { "count": 42 } } }
```

The guards (`isProto`, `isInit`, `isState`, `isMsg`, `isExit`) narrow a decoded
frame to one of these shapes. `server.ts` and `client.ts` speak only in `Channel`
plus these guards.

### Sender identity

`$msg` carries `fromName` plus the message body. On receipt the server rebuilds
the sender with `makeSender(fromName, parentName, parentId)`: if the message is
from the parent (`fromName === parentName`), the parent's `Symbol.for` id is
used; otherwise a fresh `Symbol()`. Cross-boundary *message* identity is
therefore not preserved for non-parent senders — a plain symbol can't survive
serialization.

`$init` is different: `parentName`/`parentIdName` are `Symbol.for` names, so the
parent's identity *does* round-trip — both sides resolve the same global symbol
by name.

### Framing is **not** here

- **Encoding** (JSON) is the protocol's job — `encode`/`decode` turn a frame
  object into a string and back, and the version names it (`json.v1`).
- **Framing** is how a byte stream is split back into discrete messages. It
  belongs to the transport — the transport is the thing that must split the
  stream.

So `encode`/`decode` stay in the protocol (JSON only, no delimiter); the
transport adds and strips the delimiter. WebSocket and Worker have native
message boundaries, so they add nothing.

## Transport

There are two currency types above the transport:

```ts
interface StringTransport {
  send(frame: string): void | Promise<void>;
  onMessage(handler: (frame: string) => void): void;
  removeHandler(): void;
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

interface Channel {
  send(frame: Record<string, unknown>): void | Promise<void>;
  onMessage(handler: (frame: Record<string, unknown>) => void): void;
  removeHandler(): void;
  onClose(handler: () => void): void;
  close(): Promise<void>;
}
```

`StringTransport` moves encoded frames (strings); `Channel` moves decoded frame
objects. `json1Channel(transport)` wraps the former into the latter.

| Transport | Implements | Encoding | Client reaches the server by |
| --- | --- | --- | --- |
| **FIFO** (`fifo.ts`) | `StringTransport` | `json.v1` | spawning the child and opening the fifo |
| **WebSocket** (`websocket.ts`) | `StringTransport` | `json.v1` | connecting to `ws://` / upgrading a request |
| **Worker** (`worker.ts`) | `Channel` | `clone.v1` | `new Worker(url)` |

FIFO and WebSocket carry JSON-encoded strings; `json1Channel` decodes them. The
worker case is different: `postMessage` structured-clones the frame object
directly, so `WorkerTransport` implements `Channel` and there is no JSON.

## Spawners

A transport is *how* frames move; a spawner is *how a transport is obtained*.
The seam takes a spawner, not a transport, so environment differences — and
future isolation wrappers (`sudo`, `bwrap`, `docker`) — are a spawner transform,
not a seam concern.

```ts
type Spawner = () => Promise<Channel>;          // server side
type ClientSpawner<Args> = (args: Args) => Promise<Channel>;  // client side
```

The spawner owns the `$proto` handshake: the server spawner **sends** `$proto`
and returns the channel; the client spawner **awaits and validates** `$proto`
and returns the channel. The seam starts at `$init` and never sees the version
string.

| Spawner | Side | Bootstraps by |
| --- | --- | --- |
| `fifoArgvSpawner()` | server | reading `--fifo-in`/`--fifo-out` from argv |
| `commandSpawner(command)` | client | `mkfifo` + spawning the command |
| `wsServerSpawner(ws)` | server | wrapping an already-upgraded socket |
| `wsClientSpawner(url)` | client | `new WebSocket(url)` |
| `workerSelfSpawner()` | server | wrapping the worker-global `self` |
| `workerClientSpawner(url)` | client | `new Worker(url)` |

## The seam

### Server — `serveRemoteActor(actor, spawner)`

Serves one actor over a `Channel` produced by the spawner:

1. await the spawner's channel (the `$proto` handshake is already done)
2. await `$init`, split domain args from parent identity
3. spawn `actor` via `actor.spawn(args, { name: "remote", parentName, parentId })`
4. bridge: channel-in → `proc.send`; `proc` emit → `$msg`/`$state`; on exit → `$exit`
5. close the channel

It takes the `ActorDefinition` (not a bare `fn`), so plugins and reflection
survive the spawn — only `actor.spawn` runs `resolvePlugins` and
`attachReflection`.

### Client — `remoteClient(name, spawner)`

Returns a full `ActorDefinition` whose `setup` connects through the spawner and
whose handlers drive a proxy:

1. `setup` awaits the channel, sends `$init`, awaits the first `$state`
2. `onMessage` forwards each message over the wire and `stopPropagation`s
3. `onStopRequested` sends `STOP` and awaits `$exit`
4. `afterEnd` closes the channel

The proxy is an ordinary actor — `spawn`/`send`/`state`/`wait` work exactly as
for a local actor. The `afterEnd` close is what lets the client terminate the
peer: a worker can't self-terminate (Bun has no `self.close`), so the client
must `terminate()` it when the proxy ends. For FIFO and WebSocket the close is
idempotent and harmless.

The two functions are the **same seam seen from two sides**, not two layers. They
must version together, because they share the protocol.

### Exit

| Scenario | What the client sees |
| --- | --- |
| server sends `$exit` | `$exit` frame, then close |
| clean close, no `$exit` | close; `wait()` resolves `{ code, lastState }` |
| abrupt drop / SIGKILL | close; `wait()` resolves `{ code: null, lastState }` |

`STOP` works end-to-end: client `send({ type: "STOP" })` → server
`onStopRequested` → `$exit` → client `wait()` resolves.

## The glue — `defineSubprocessActor`

The demoable sugar for the subprocess case. It wraps an actor definition so
spawning it runs it in a subprocess over two named fifos, while the same module
can also be the server entry point:

```ts
export const counterRemote = defineSubprocessActor(CounterActor, import.meta.url);
// counterRemote.actor        — the proxy (spawn it like a local actor)
// counterRemote.runRemoteRoot() — serve the real actor (called by the child)
// counterRemote.isRemoteRoot   — true when running inside the child
```

Under the hood it is just the client side of the seam plus a FIFO bootstrap:
`--remote=<pathhash>` argv-marker detection for `isRemoteRoot`, runner
auto-detection (`bun`/`node`), and `commandSpawner`. This is the only place in
the subprocess path that imports transports/protocols.

## Out of scope

Process-isolation wrappers from the earlier draft (`withSudo`, `withBwrap`,
`withSsh`) are FIFO-transport concerns — they rewrite the spawn command — and
are not part of the transport-agnostic seam. With the spawner design they become
spawner transforms.

`env` (a `setup(args, env)` execution-context parameter carrying the socket,
request, or peer) is a separate future concern: it threads through
`spawnAsync`/`start`, not through the remote seam, and is deliberately not
conflated with `$init`.

## Open questions

- **Route naming on the server.** `serveRemoteActor` takes an already-established
  channel; mapping a WebSocket route to an actor name stays in the consumer's
  court (or a small `name → actor` registry helper).
- **`parentName`/`parentIdName` for a multi-client server.** For one server, many
  clients, what identifies each connection?
- **`$fd` (stdout/stderr forwarding).** The earlier draft proposed a sixth frame
  for process output. Not implemented, and process-specific — likely belongs as
  a FIFO-transport extension, not a core frame.
