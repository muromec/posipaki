# Remote Actors

**Status:** Implemented, brought up to date on 2026-10-11 against the tree: the frame vocabulary is the
sixteen frames below with one exported `Frame` type (`dbe75a8`), `Channel.onMessage` returns its own
unsubscribe, the spawner table is what exists, and the seam is served by a one-connection
[reactor](server-reactor.md).  The channel handle each starter gets, the fan-out behind that
unsubscribe, and the byte streams over a connection are [the connection both ends
hold](connection-both-ends.md).
>
> **Superseded in part, 2026-11-07.** The carrier under the seam is being replaced by a **port** — a channel,
> a spawner and an adapter, with its own entry point: [Ports](ports.md). The sixteen frames, the reactor,
> the stream references and both wire versions do not change; the *Layers*, *Transport* and *Spawners*
> sections below describe the tree as it is at 0.47.0 and say where each part is going.

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

The carrier is a **port** — a channel, a spawner and an adapter — and it has its own document and its own
entry point: [Ports](ports.md), `posipaki/port`.

```
┌──────────────────────────────────────────────────────────────┐
│  glue       defineSubprocessActor               sugar        │
├──────────────────────────────────────────────────────────────┤
│  seam       serveRemoteActor · remoteClient     server/client│
├──────────────────────────────────────────────────────────────┤
│  frames     Channel<Frame> · guards             frame vocab  │
├──────────────────────────────────────────────────────────────┤
│  adapters   handshake · json.v1                 protocol step│
├──────────────────────────────────────────────────────────────┤
│  port       Channel<Part|Uint8Array> · Spawner  medium       │
│             Listener · the owner actor                       │
└──────────────────────────────────────────────────────────────┘
```

| Layer | Files | Owns |
| --- | --- | --- |
| **Port** | `port/` (proposed) | A channel of parts or bytes, the spawner that makes one, the listener that accepts one, and the owner that holds one. Nothing here knows a frame. |
| **Adapter** | `port/adapters/`, `protocols/json1.ts` | The `$proto` handshake and `json.v1`: a port in, frames out. The worker needs neither — structured clone already carries frame objects. |
| **Frames** | `channel.ts` | The sixteen `$`-shaped frames and the guards that narrow one. This is the seam's shared vocabulary. |
| **Seam** | `server.ts`, `client.ts` | `serveRemoteActor` / `remoteClient` — pump frames over a `Channel<Frame>`. |
| **Glue** | `define-subprocess.ts` | `defineSubprocessActor` — wrap the client side as a normal actor definition. |

Each rung is a stable interface, usable on its own. You don't climb to the top if you don't want to, and
the seam never sees a specific medium, protocol or spawner: it sees a `Channel<Frame>` and nothing below it.
**As built at 0.48.0, after the first half of the split.** The remote composes its connection: `partsOf`
turns the line transport a listener hands up into the port's parts, and `seamOf`/`jsonSeam` run
`handshake(json1(...))` over them, so both ends reach the protocol the same way round. `StringTransport` and
`json1Channel` survive inside the transports, and `Spawner`/`ClientSpawner` still name the frame channel: the
type change, the listeners returning a channel and `oneConnection` going away are the rest of
[Ports](ports.md).

## Protocol

The protocol is a set of **frame objects** — plain JS objects carrying a single
`$`-key each. It knows nothing about framing; that is the port's business ([Ports](ports.md)).

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

Sixteen frames, in five groups.  A frame is one JSON object carrying one `$` key; the key says what
it is, and the body under it belongs to whoever wrote it.  The whole set is one exported type,
`Frame` (`channel.ts`), which a protocol re-exports as the frames it carries.

| Frame | Direction | Purpose |
| --- | --- | --- |
| `$proto` | server → client | version handshake, once on connect |
| `$init` | client → server | domain args, the root's name, and parent identity |
| `$state` | server → client | state snapshot (the first after `$init` signals ready) |
| `$msg` | bidirectional | a posipaki message crossing the boundary |
| `$exit` | server → client | graceful exit + final state |
| `$bad` | either | this side could not read a frame: why, its length, and a short head of it |
| `$error` | either | the wire cannot be spoken over, and why; the connection ends with it |
| `$fd` | either | the connection root's own stream: which one (0, 1, 2) and the text |
| `$stop`, `$pause`, `$resume`, `$release`, `$tune` | whoever holds the process | stop it, pause it, resume it, let it go, say less about it |
| `$r.methods`, `$r.call.<name>`, `$r.result.<name>` | either | reflection: what a process answers, the ask, the answer |

```json
{ "$proto": "json.v1" }
{ "$init": { "args": { "start": 0 }, "rootName": "host:tools", "parentName": "host", "parentId": "host" } }
{ "$state": { "count": 1 } }
{ "$msg": { "fromName": "root", "body": { "type": "INCREMENT", "by": 1 } } }
{ "$exit": { "code": 0, "state": { "count": 42 } } }
{ "$fd": 1, "data": "ready\n" }
{ "$r.call.getState": { "seq": 1, "args": [] } }
```

A frame about a process carries that process's id as `to`, at the top level of the frame rather than
inside its body: the frame is the envelope, and the address says who it is for whatever kind it turns
out to be (`frameTo`).  The guards — `isProto`, `isInit`, `isState`, `isMsg`, `isExit`, `isBad`,
`isError`, `isStop`, `isPause`, `isResume`, `isRelease`, `isTune`, `isReflectionMethods` — narrow a
decoded frame to the frame it is.  `server.ts` and `client.ts` speak only in `Channel` plus these
guards.

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

### Framing is a port's business

- **Encoding** (JSON) is the protocol's job — `encode`/`decode` turn a frame object into a string and back,
  and the version names it (`json.v1`).
- **Framing** — how a byte stream is split back into discrete messages — belongs to the layer that has the
  bytes, and in the target shape it is an *adapter* over a byte channel rather than a rule every transport
  implements for itself: a part is a line plus the octets it announced ([Ports](ports.md)). WebSocket and
  Worker have native message boundaries and add nothing.

Today that split is written per transport — `lines.ts`, called by fifo, stdio and socket — which is one rule
in three places. The seam above it sees no delimiter either way.

## Transport

There is one currency above the medium: `Channel<Frame>`, the sixteen frames and the guards in `channel.ts`.
Below it is a port, whose frames are parts or bytes ([Ports](ports.md)).

`json1Channel` is what stands between them today: it wraps a `StringTransport` into a `Channel`, and that
wrapper is where several readers on one connection are kept — one handler on the transport, every frame
offered to every subscriber, so a second reader (a log stream, a terminal's own output) is a second entry
and not a second handler. The transports keep their one-handler contract and throw on a second one, which is
why the fan-out belongs above them. In the target shape that wrapper is `json1`, and the fan-out is the
channel's own `onFrame`.

| Transport | Implements | Encoding | Client reaches the server by |
| --- | --- | --- | --- |
| **FIFO** (`fifo.ts`) | `StringTransport` | `json.v1` | spawning the child and opening the fifo |
| **WebSocket** (`websocket.ts`) | `StringTransport` | `json.v1` | connecting to `ws://` / upgrading a request |
| **Worker** (`worker.ts`) | `Channel` | `clone.v1` | `new Worker(url)` |
| **Line** (`stdio.ts`) | `StringTransport` | `json.v1` | a stream pair: our own fds, a unix socket (`connectUnixSocket`), or a command's stdin/stdout |

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

The spawner owns the `$proto` handshake, and at 0.48.0 it is symmetric: both ends announce
and both await the other's word. A spawner composes it from `seamOf(transport)` — a medium
that frames its own lines — or `jsonSeam(channel)` — raw bytes — and the seam above starts
at `$init` and never sees the version string.

> **Target, from [Ports](ports.md).** A spawner narrows to its medium: it returns the channel that medium
> gives — parts or bytes — and stops doing the handshake and the encoding. What the seam receives becomes
> `handshake(json1(spawner(args)))`, composed once at the entry point instead of rebuilt inside eight
> spawners. What each spawner *opens* does not change, which is what the table below says.

| Spawner | Side | Bootstraps by |
| --- | --- | --- |
| `fifoArgvSpawner()` | server | reading `--fifo-in`/`--fifo-out` from argv |
| `fifoClientSpawner(pair)` | client | opening the pair the other way, then awaiting `$proto` |
| `commandSpawner(command)` | client | `mkfifo` + spawning the command |
| `wsServerSpawner(ws)` | server | wrapping an already-upgraded socket |
| `wsClientSpawner(url, { WebSocket, options })` | client | opening one, with headers or a CA for the opener |
| `workerSelfSpawner(selfScope)` | server | wrapping the worker-global `self` |
| `workerClientSpawner(url)` | client | `new Worker(url)` |
| `socketClientSpawner(path, { onOutput })` | client | connecting to a unix socket |

## The seam

### Server — `serveRemoteActor(actor, spawner)`

Serves one actor over a `Channel` produced by the spawner:

1. await the spawner's channel (the `$proto` handshake is already done)
2. await `$init`, split domain args from the names
3. spawn `actor` via `actor.spawn(args, { name: rootName, parentName, parentId })`

`rootName` is what the client calls the process it is serving — its own end of the connection,
fully qualified — so the served root is named on that side the way the side that forked it names
it, and everything under it is spelled off that.  A client that states none (an older one, or a
hand-written `$init`) is served as `SERVED_ROOT_NAME`.
4. bridge: channel-in → `proc.send`; `proc` emit → `$msg`/`$state`; on exit → `$exit`
5. close the channel

It takes the `ActorDefinition` (not a bare `fn`), so plugins and reflection
survive the spawn — only `actor.spawn` runs `resolvePlugins` and
`attachReflection`.

`serveRemoteActor(actor, spawner)` is the one-connection case of the
[reactor](server-reactor.md): `reactor(oneConnection(spawner), actor)`.  The session it reports carries
the connection's `channel`, and `onSession` may return a cleanup — which is how the code that started
the connection, and not only the factory, gets to send and read frames on it.

### Client — `remoteClient(name, spawner, options)`

Returns a full `ActorDefinition` whose `setup` connects through the spawner and
whose handlers drive a proxy:

1. `setup` awaits the channel, sends `$init`, awaits the first `$state`
2. `onMessage` forwards each message over the wire and `stopPropagation`s
3. `onStopRequested` sends `STOP` and awaits `$exit`
4. `afterEnd` closes the channel

`options.onChannel(channel, ctx)` is called once the channel is up, with the connection the proxy
holds: the client side's way to send and read frames.  Its return value is a cleanup, run when the
wire goes or the proxy stops.

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

- **A second client on one server.**  What identifies a connection is the listener's `meta`, which each
  medium fills in its own way (a socket's path and peer, a websocket's upgrade request).  The session
  carries it, so nothing here has to invent an identity.
- **A running process served on a connection.**  The factory returns the process, nothing stops a
  process it did not spawn, and its out-messages have to reach every connection bound to it.  See
  [the server reactor](server-reactor.md).
- **The connection's streams.**  `$fd` is a frame now; fd 0, the streams over a connection and who owns
  them are [the connection both ends hold](connection-both-ends.md).
