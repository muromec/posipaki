# Ports: a channel, a spawner, an adapter

> **Status:** built, and shipping as **0.50.0**.  The seam moving onto ports (slice 5) is still the next release.
>
> **`posipaki/port`** — `Channel<F, C>` with its three endings, `info` and `control`; `memoryChannelPair`,
> `streamChannel`, `splitChannel`, `held`, `all`/`settled`, `duplexChannel`, `portReactor`, `portActor`, and
> `fetchPort`, whose `HttpRefusal` carries the status a peer answered with.  Nothing in this entry knows a
> protocol.
>
> **`posipaki/port/node`** — `spawnPort`/`spawnPorts` and the two actors over them (`BinaryPort`, `Utf8Port`), and
> `httpListener` on `node:http`: a request arrives as a pair of ports, and its status and headers are a
> `control({head})` on the outbound one.
>
> **Beside the port entry, where the medium is:** `unixSocketListener` and `connectUnixSocket`
> (`src/remote/socket.ts`), and `webSocketListener` with its two structural adapters (`src/remote/websocket.ts`).
> Each takes an `upgrade` or an accept that the library cannot own on every runtime, so they stay in the remote
> until a package owns the server.
>
> json.v1 and the handshake are adapters only this library's remote uses, so they live with it:
> `src/remote/protocols/json1.ts` and `src/remote/handshake.ts`, composed in `src/remote/seam.ts` as
> `handshake(json1(split(port, announced)))`.  The remote is on it: the payload's fifo pair is a byte channel, and
> the serving half and every client spawner reach the protocol through the same chain.  Both ends announce, which
> is a **behaviour change**: a peer that used to only listen now has to say what it speaks, or the handshake it is
> part of never finishes.
>
> **Not built, named as the next slice:** `Spawner` and `ClientSpawner` still name the frame channel — a spawner
> is a port internally, but its type says `Promise<Channel>`.  So `StringTransport` and `json1Channel` survive
> inside the transports, the listeners still hand up a transport, and the seam composes over one rather than over
> a port.  Moving those three types is the breaking half, and it lands when `Listener` returns a channel and
> `oneConnection` stops existing.
>
> The rest of the plan below stands: the sixteen frames, the reactor and both wire versions do not change, and
> this document supersedes the *Layers*, *Transport* and *Spawners* sections of
> [Remote Actors](actor-remote.md).  It is also the channel that [xfetch as a pipe](xfetch-as-a-pipe.md) deferred
> when it said a stream wants one and called it "a different proposal".

## Terms

The words this document and the code use, each with one meaning.

- **frame** — one value a protocol puts on a connection. For the remote seam it is a plain object with a single
  `$`-key (`$proto`, `$init`, `$msg`, …), defined in `src/remote/channel.ts`.
- **channel** — values of one type `F` between two ends, with three endings: `close()` from this side, `onClose`
  from the far side, `onError` when the transport fails. `src/port/channel.ts`.
- **part** — one line and the octets that line announced. What a medium that frames its own messages produces,
  and what the splitter produces from bytes.
- **medium** — whatever carries the bytes: a fifo pair, a unix socket, a WebSocket, a child's stdio. It opens,
  closes, and knows nothing about frames.
- **port** — a channel a medium produced, before any protocol is applied. `src/port`.
- **protocol** — the encoding of frames as bytes or lines, and their meaning: `json.v1` here.
- **adapter** — a function from one channel to another of a different frame type: `splitChannel`, `json1`,
  `handshake`, `frameChannel`.
- **handshake** — the adapter that is asynchronous: each end sends `$proto`, each waits for the other's, and it
  resolves to the channel above it.
- **spawner** — a factory: arguments in, a connection out. On the serving side a spawner opens the medium it was
  started on (a payload's fifo pair in argv); on the client side it opens one to a far side.
- **listener** — where connections arrive. `accept()` gives a connection and whatever the medium knows about the
  peer; `close()` releases the medium.
- **seam** — this library's name for the remote layer as a whole: `serveRemoteActor` on one side,
  `remoteClient` on the other, and the frames they exchange.

## The problem

Three jobs are fused into one interface, and which two are fused differs by medium.

A **spawner** is supposed to be a factory: hand it arguments, get a connection, and it is gone. Today
`fifoArgvSpawner`, `wsClientSpawner`, `socketClientSpawner` and their server twins run the whole stack
inside themselves — line framing, the `$proto` handshake, and `json1Channel` — so what comes back is a
`Channel` of decoded frames. There is no point at which a caller holds the connection itself, and so:

- a second protocol cannot be put on one of these mediums. You cannot ask a fifo for bytes, or a unix
  socket for lines: both arrive wearing `json.v1`.
- the adapter is not a value. It cannot be swapped, wrapped, or tested on its own.
- the serving side is already split the other way: `reactor(listener, serve)` takes a `Listener`, receives
  a `StringTransport`, and applies json1 itself. So the two ends of one seam are built at different depths,
  which is why `oneConnection(spawner)` has to exist at all: it is an adapter that lets a spawner pretend to
  be a listener.

The framing decision is also inside the channel's signature. `StringTransport.onMessage(handler)` takes a
handler that **returns the number of octets that follow**, and `sendBytes` writes those octets:

```ts
interface StringTransport {
  send(frame: string): void | Promise<void>;
  onMessage(handler: (frame: string) => number | void): void;
  onBytes(handler: (bytes: Uint8Array) => void): void;
  sendBytes(bytes: Uint8Array): void | Promise<void>;
  onClose(handler: () => void): void;
  close(): Promise<void>;
}
```

Two callbacks and a count are how "a line, and the octets it announced" is expressed. That is a framing
decision — a length-prefixed message — made in the type every medium has to satisfy.

And the splitter itself is written twice: `lines.ts` in this library (13.3 MB of 87 kB frames: 4.0 s
through `node:readline`, 76 ms through a buffer and `indexOf`, with `PartReader` carrying a line and the
octets that follow it), and again in the harness for HTTP bodies, which is a different medium with the same
rule.

## The shape

Three types, and every medium, protocol and port becomes a composition of them.

```ts
/** Values of one type, between two ends.  `C` is what the far end says when it closes. */
export interface Channel<F, C = string> {
  send(frame: F): Promise<void>;
  /** A frame arrived.  The returned function stops this reader and no one else. */
  onFrame(handler: (frame: F) => void): () => void;
  /** The far side closed, and this is what it said.  Once, after any frames already read. */
  onClose(handler: (reason: C) => void): () => void;
  /** The wire failed.  Once, and always before the close. */
  onError(handler: (error: unknown) => void): () => void;
  /** Close it from this side.  Idempotent; the reason is ours, so it is a sentence. */
  close(reason?: string): Promise<void>;
  /** What the medium knows about itself: a process its pid, a request its method and url. */
  readonly info: Record<string, unknown>;
  /** Ask the medium to act on what is behind it.  A signal is the first command. */
  control(command: Record<string, unknown>): void;
}
```

```ts
/** A factory: arguments in, a connection out, and the factory is gone. */
export type Spawner<Args, F> = (args: Args) => Promise<Channel<F>>;

/** Where connections arrive.  The listener owns its medium; the caller owns what it accepts. */
export interface Listener<Meta, F> {
  accept(signal?: AbortSignal): Promise<{ channel: Channel<F>; meta: Meta }>;
  close(): Promise<void>;
}

/** What wraps a channel: another channel of a different frame type, over the same one. */
export type Adapter<In, Out> = (inner: Channel<In>) => Channel<Out>;
```

`Spawner` and `Listener` as drawn above are slice 5's target.  What ships today is `PortListener<In, Out, Meta>` —
`accept()` gives a `PortPair`, the request's two channels and its meta — and `portReactor` over it; the spawners
still hand up a frame channel, which is the other half of that slice.

The unit above a byte channel is a **part**: one line of text, and the octets it announced.

```ts
/** What a medium hands up before any protocol reads it. */
export type Part = { line: string; bytes: Uint8Array | null };
```

A fifo, a stdio pair or a socket gives `Channel<Uint8Array>`; the splitter gives `Channel<Part>`; a
websocket gives `Channel<Part>` directly, because its message boundary already is one; the worker gives
`Channel<Frame>`, because structured clone needs no encoding. That is the whole of the medium's job: move
parts, end them, and say when they fail.

Then the protocols are adapters, and each is one file that can be tested over a fake channel:

| Adapter | From | To | Notes |
| --- | --- | --- | --- |
| split | `Channel<Uint8Array>` | `Channel<Part>` | `lines.ts` and `PartReader`, moved wholesale |
| json.v1 | `Channel<Part>` | `Channel<Frame>` | today's `protocols/json1.ts`, applied to a channel |
| handshake | `Channel<Frame>` | `Channel<Frame>` | announces `$proto`, reads and checks the peer's |
| clone.v1 | — | — | nothing: the worker's channel already carries frames |

## What a composition looks like

```ts
// the seam over any medium that hands up bytes: what jsonSeam composes
const bytes = await fifoArgvSpawner(own)(args);   // Channel<Uint8Array>
const seam = handshake(json1(split(bytes)));      // Channel<Frame>

// the same chain with a name, for the spawners that ship
serveRemoteActor(actor, jsonSeam(() => fifoArgvSpawner(own)));

// a medium that already frames its own messages: no splitter under it
const parts = await socketClientSpawner(path)(args);   // Channel<Part>
const seam = jsonSeamParts(() => socketClientSpawner(path));

// a process as a port: an actor over one channel, holding one life
const port = await this.fork(BinaryPort, { command: ['bun', 'x'] });
```

`json1` is the only place the version string appears; `split` is skipped for a medium whose message boundary is
already a part.

## Where remotes sit

Remotes are built on top of ports. The seam is one composition of them and owns no medium of its own:

```ts
const seam = handshake(json1(split(port)));   // either end, over any medium
```

Everything above that line stays in `posipaki/remote` and is unchanged: the sixteen frames,
`$init`/`$state`/`$msg`, the reactor and its sessions, the stream and blob references, the kit and the
gateway. What changes is the line under it. A served connection is a port that was accepted; a client is a
port a spawner made; the `$proto` handshake is an adapter both ends apply before the seam sees it.

Two consequences:

- `oneConnection(spawner)` goes, because a spawner is no longer pretending to be a listener;
  `fromSpawner(spawner)` is the listener that accepts exactly one.
- `StringTransport` goes, and the octet announcement it carried becomes the splitter's business: a part is
  a line plus the octets it announced, and `onBytes`/`sendBytes` have no counterpart.

Both consequences are slice 5's, and neither has happened: `oneConnection` is still the listener a spawner is
wrapped in, and `StringTransport` is still what the transports hand up.

## The owner

A channel is not a process. Something must hold it, hear its death, and stop what is underneath: the child, the
socket, the request. That is an actor, and it is built: `portActor` in `src/port/actor.ts`.

```ts
export interface PortPublic<C> {
  alive: boolean;                 // the channel is open
  end: C | null;                  // how it ended, and null until it has
  info: Record<string, unknown>;  // what the medium said about itself
}

portActor<Args, F, C>({ name, open(args): Promise<Channel<F, C>> });
```

In `SEND {data}` writes to the channel, `SIGNAL {signal}` becomes `channel.control({signal})`, and out is `DATA
{data}` for every frame.  When the channel closes the actor writes `end`, clears `alive`, and stops — the ending is
state, not a message, because a parent reads state anyway and the death of the port is the death of the actor.

The harness's process port is this: `BinaryPort` and `Utf8Port` in `src/port/node/process.ts`, over `spawnPort`.

## Way in: what a package exports

A medium is not a place. `ssh` is an argv prefix over the same child-process medium, `podman exec` is the
same with a container's lifetime around it, and `bwrap` the same inside a namespace. So the crossing is one
implementation in the core — `RemoteWayIn { name, entry, run?, spawn? }` is already that interface — and a
companion package is only what it alone can say: the argv, the spec, and the lifetime it owns.

**Not built.**  What exists is the way-in interface above and the spawners that use it.  The store and the gateway
below are the design for slice 9: `filesOver` and `gatewayPort` are not in the tree, and a package still stages a
kit the way it always did.

The primitive under all of it is a **file store over a way in**, and a gateway that is a function of what it
is handed:

```ts
/** A file that is on the environment, and what it takes to run it. */
export type Artifact = { path: string; digest: string; runtime?: string[] };

/** Files on the other side of a way in.  Nothing here knows which way in it is. */
export interface FileStore {
  put(name: string, bytes: Uint8Array): Promise<Artifact>;
  /** These exact bytes are there — what a second spawn asks instead of staging again. */
  has(digest: string): Promise<boolean>;
  remove(digest: string): Promise<void>;
}

/** A port into our own payload, over a store that already holds it. */
gatewayPort(wayIn, store, { gateway: Artifact, payload: Artifact }): Spawner<Args, Uint8Array>;
```

So a package exports a **way in** and nothing else, and everything above it is core:

| Where | What | Over what |
| --- | --- | --- |
| `posipaki-remote-ssh` | `sshPort(host, command)` — the way in | the `ssh` binary |
| `posipaki-remote-podman` | a way in, plus the container's lifetime | `podman exec -i` |
| `posipaki-remote-bwrap` | a way in, plus the namespace argv | `bwrap` |
| core | `filesOver(wayIn)` — the store | one command per file, through the way in |
| core | `gatewayPort(wayIn, store, artifacts)` | the two artifacts |
| core | `sshRemote(spec)` = `seamOf(gatewayPort(wayIn, store, spec.artifacts))` | all of it |

Two things the store buys that a `stageKit` step could not:

- **The version check becomes a lookup.** Today the payload is trusted to state which build it is
  (`--host-version=`, compared against its own bytes) and the far side's report is parsed to find out what
  happened. With the store keyed by digest, `has(sha256)` answers "these exact bytes are there", which is the
  question the string was approximating, and it needs no cooperation from whatever is running. `sha256Hex` is
  already here.
- **One staging implementation, not three.** The store and the gateway are shared *and* named, so the three
  packages differ in an argv and, for podman, a lifetime.

If `gatewayPort` and `seamOf` are ever more than one line apart, something above the port is still fused.

**A wrapped port is not a raw one, and that is the reason to have both.** A command's stdout carries whatever
the command prints; the gateway's wrapping is what keeps a worker's own output out of the channel, so a port
through it carries protocol bytes only. A foreign program — an MCP server, a database shell — has no such
guarantee, and a stray print then arrives as a frame that fails to parse: a visible failure, which is the
right kind, and the reason a protocol that cannot tolerate one takes the wrapped path.

**A foreign command's failure is only known at the close.** `ssh host -- nope` connects and then exits 127,
so the spawner cannot refuse it the way it refuses a connection that never opened. The sentence belongs to
whichever spawner started the child, and it travels as the channel's close reason: `exit 127: bunx: command
not found`, with the last lines of what it said on stderr.

**Which layer a piece goes into** is a rule the tree already follows, made explicit:

- a companion package is for an external runtime you may not have — the `ssh` binary, podman's daemon,
  bwrap's namespaces. It earns its keep with its own fixtures, its own integration tests and a lockstep
  version;
- everything with no such dependency is an *entry* of the core package — `/port` and `/port/node`, beside
  `/remote`, `/remote/node` and `/xfetch`;
- a 0.x breaking change moves every companion pin in the same commit, because `^0.47.0` does not admit
  `0.48.0`; the three are published with the core or not at all.

## What it does not do

- **No backpressure.** The library has none today; a channel accepts frames as fast as the adapter decodes
  them. A consumer that cannot keep up buffers, and the bound is the consumer's (`StreamStore` for octets
  over the seam, `maxFrames` in the harness for a runaway producer).
- **No reconnection.** A closed channel is closed. A caller that wants the connection back spawns another
  and deals with what it lost.
- **No retry, no negotiation, no multiplexing.** A protocol adapter that wants several conversations over
  one channel tags its frames; that is its business, not the channel's.
- **No buffering of what was already read.** A close does not replay frames the handler did not take.

## Decisions

- **A frame type, not a channel variant.** Text is `{line, bytes}`, so a binary medium and a text medium are
  the same channel with different adapters. This deletes `sendBytes` and `onBytes`, and it deletes the
  `WorkerTransport implements Channel` special case: the worker is a spawner whose channel carries `Frame`
  already.
- **A spawner that cannot connect fails before it returns.** A refused socket, a non-2xx answer, a failed
  handshake: the call rejects, and no channel exists. There is nowhere in a channel for "and then it did
  not start", and the status code a caller needs is not a frame.
- **The handshake is an adapter, not a spawner's job.** `$proto` is one frame each way; a spawner that has
  to know about it is a spawner that cannot be reused for anything else. `oneConnection(spawner)` then goes
  away, because a spawner is no longer pretending to be a listener: `fromSpawner(spawner)` is the listener
  that accepts exactly one.
- **`Listener` returns the meta beside the channel.** Admission is the listener's (`identify`), and what it
  learned is not part of what travels. `{ channel, meta }` keeps them apart, which the reactor's
  `Connection<Meta>` already does.
- **The seam's vocabulary is untouched.** Sixteen frames, `json.v1` and `clone.v1`, `StreamRef`/`BlobRef`
  and `StreamStore`. This document is about what carries them, not what they say.
- **Breaking, and taken deliberately.** `StringTransport` disappears; the spawners and listeners change
  their return type; `onBytes`/`sendBytes` are gone. Compatibility helpers (`jsonSeam`, `fromSpawner`) keep
  `serveRemoteActor`, `remoteClient` and `defineSubprocessActor` callable as they are today, so the harness
  can stay on 0.47.0 through the whole change and move one consumer at a time afterwards.
- **The close carries a sentence by default, and `C` when the medium has one.** *(Superseded 2026-11-07: this
  said the close is always a sentence and that a channel which understood process exits would stop being a
  channel. The process port showed the cost — flattening `{code}` into prose throws away the one fact the caller
  wants — so the close became `Channel<F, C>`: `C` is what the far end says, a sentence for a medium, an exit for
  a process. `close()` from this side still takes a sentence, because that close is ours.)*
- **The store puts one file at a time, and keeps its own index.** A file goes through the way in as the bytes
  one command reads on stdin, and lands where the artifact says; the digest is computed here, before it is
  sent, so `has` asks a question that does not need the bytes to travel. The index (digest → path) is written
  beside them, which makes `has` one read rather than a hash of every candidate. No archive: a tar would be a
  second encoding of the same bytes, a second thing to get wrong on a far side nobody is watching, and a
  format the library would then have to keep.

## Cost

Every transport and every spawner in this tree changes, and their tests with them: `transports/fifo.ts`,
`transports/websocket.ts`, `transports/worker.ts`, `lines.ts`, `stdio.ts`, `socket.ts`, `fifo.ts`,
`spawners/*`, `reactor.ts`, plus `server.ts`/`client.ts`'s entry points. The seam, the frame vocabulary and
both wire versions are untouched, so the risk is confined to the carrying layer and the gate covers it: the
existing integration tests (client, server, ws, fifo, stream, reflection) run unchanged and are the proof
that the recomposition carried the same behaviour.

Downstream, one harness pins this and uses four of the media today (fifo for an environment payload, a unix
socket for a console endpoint, a websocket client for a display and for a voice connection, a websocket
server in a test double). All four keep working through the helpers.

## Slices

Each one is a red test first, and the suite stays green between them.

1. **`Channel<F>` and its three endings.** The type, a fake channel for tests, and the guards. Nothing else
   changes yet: `Channel` is renamed to `FrameChannel` where the seam means frames.
2. **Spawners return raw channels.** `fifoArgvSpawner` returns `Channel<Uint8Array>`, `wsClientSpawner`
   returns `Channel<Part>`; `clientChannel` stops being called by them. `jsonSeam(spawner)` restores the
   old contract for `defineSubprocessActor` and `remoteClient`, so the suite survives.
3. **The splitter becomes an adapter.** `lines.ts`/`PartReader` move under `adapters/`, and every medium
   that split lines stops doing it.
4. **The handshake becomes an adapter**, and `oneConnection` becomes `fromSpawner`.
5. **Remotes move onto ports.** The seam takes a port instead of a `StringTransport`, `oneConnection` goes,
   and `serveRemoteActor`/`remoteClient` keep their signatures. This slice is the proof of the split: the
   whole remote suite runs on the new carrier with nothing above the seam changed.
6. **The owner.** *(Built 2026-11-07: `src/port/actor.ts`, one actor over one channel, and the harness's process
   port is `BinaryPort`/`Utf8Port` over `spawnPort`.)* `process-streams.ts` and `stdio.ts` grow into a spawner over
   a child, which is where the code it replaced now lives.
7. **The second medium that is not a process**: an HTTP connector returning `Channel<Part>` over an SSE or
   chunked body, which is what `xfetch`'s streaming half becomes.
8. **Docs**: [Remote Actors](actor-remote.md) states the composition and links here;
   [The connection both ends hold](connection-both-ends.md) loses the octet announcement, because it is now
   a framing adapter; [environment remote spawner packages](environment-remote-spawner-packages.md) says a
   spawner's product is a raw channel.
9. **The store and the gateway, in core**: `filesOver(wayIn)` and `gatewayPort(wayIn, store, artifacts)`, with
   the three packages cut back to a way in (podman's container lifetime with it). Their integration tests then
   prove the seam over ssh, podman and bwrap on the new carrier, and a cheaper test covers a command run there
   for its own sake.

## Open

- **The name of the unit above a byte channel.** `Part` is short and says nothing on its own. `Line` is
  false when it carries octets; `Message` is taken by the actor. A reader who has to open this document to
  learn what a frame is has not been helped.
- **Does the owner belong here or beside it?** *(Answered 2026-11-07: here. It is one actor over a channel with
  no knowledge of a medium, and the kill policy stayed with whoever opens the channel — `close()` — so the actor
  needed none of its own.)*
- **Whether a listener should be a spawner.** `accept()` repeated is a loop with its own lifetime, which a
  factory is not. Keeping them apart costs the `fromSpawner` shim and keeps each honest.
- **One compatibility helper or two.** `jsonSeam(spawner)` can only exist once, for a spawner whose channel
  carries bytes; one that already hands up parts needs `jsonSeamParts`, or a single helper that takes the
  spawner's frame type as an argument. Which of those is worth exporting is not decided, and it is the whole
  cost of keeping old call sites alive.

## As built

Where each piece lives, as it stands today.

**`src/port/channel.ts`** — `Channel<F, C>`: `send`, `onFrame`, `onClose`, `onError`, `close(reason?)`, plus
`info: Record<string, unknown>` and `control(command)`.  `C` is what the far end says when it closes; `close()` from
this side still takes a sentence, because that close is ours.  `Part = {line, bytes?}` is one line and the octets
it announced, so a chunk of a stream is one value on the wire.

**`src/port/memory.ts`** — `memoryChannelPair()`: a channel with no medium, and the one ending a medium would
discover for it.

**`src/port/stream.ts`** — `streamChannel({read, write})`: the byte channel a stdio pair, a fifo or a socket gives.
A send settles once the stream has flushed the chunk.

**`src/port/split.ts`** — `splitChannel(inner, announced?)`: bytes into parts.  It is wrapped in `held`, because it
drains its medium the moment it is made.

**`src/port/held.ts`** — `held(inner)`: frames that arrive while nobody is subscribed are kept, and every subscriber
that arrives before the first delivery is given them; after that a later subscriber gets only what follows.  The
kept frames are not bounded, because a bound depends on what a far end may say before anyone listens.

**`src/port/combine.ts`** — `all(sources)` tags every frame with the channel it came from and ends with the first
ending; `settled(sources)` delivers every ending and closes once all have.  Neither sends: a frame put on a
combination has no destination, so `send` rejects and says so.

**`src/port/duplex.ts`** — `duplexChannel({inbound, outbound})`: a pair read as one channel, which is what an actor
is written against.

**`src/port/actor.ts`** — `portActor({name, open})`: one actor over one channel, whatever the medium behind it.  The
channel is opened in `setup`, which the runtime awaits, so a ready port has one and a port that cannot open fails
its start rather than its first frame.  `SEND {data}` writes, `SIGNAL {signal}` reaches the medium through
`control`, and out is `DATA` per frame; the ending is state (`{alive, end, info}`), not a message.

**`src/port/reactor.ts`** — `portReactor(listener, handle, options)`: the loop over a `PortListener`, one handler
per pair, `live` and `stop()`.

**`src/port/fetch.ts`** — `fetchPort(url, {init, connectMs})`: a response body as a channel.  Chunks as they
arrive, `close()` aborts, the ending is `{status}`, and a non-2xx rejects with `HttpRefusal` before a channel
exists — there is nowhere in a channel for "and then it did not start".

**`src/port/node/spawn.ts`** — `spawnPort`/`spawnPorts`: the child runs `detached`, so it leads its own process
group and `close()` ends that group after `killAfterMs` (5 s by default).  stdout is the channel's frames, stdin is
what `send` writes, stderr is a channel of its own only in `spawnPorts`, and the ending is the OS's own fact:
`{kind: "exit", code}` or `{kind: "signal", signal}`.

**`src/port/node/process.ts`** — `BinaryPort` and `Utf8Port`, both `portActor` over `spawnPort`, the second with
`splitChannel` underneath so its frames are lines.

**`src/port/node/listener.ts`** — `httpListener`: a `PortListener` over `node:http`, where a request arrives as a
pair of ports, `identify` runs before a pair exists, and a `HttpRefusal` becomes its status.

### The rules this cost

- **Nothing may be lost between a medium and its reader**, and that includes an ending.  `held` dropped the ending
  at first, so a channel that was over before anyone subscribed left every later reader waiting for a close that
  had already happened.
- **A send asked for while a channel is opening must not vanish.**  The fix was `setup`, not a promise held
  somewhere until the open resolved.
- **`open` returns a channel, period.**  The `Opened` union — `{channel, info?, signal?}` — was invented and
  shipped for an hour: the facts belong to the object the medium produced, so they became `info` and `control` on
  the channel itself.
- **A spawned command leads its own process group.**  That is the same mechanism as being killable: without the
  group there is nothing for `-pid` to name.
- **A client's response head arrives with the first frame a handler writes**, because that is how HTTP works.
  `await fetchPort(url)` therefore does not resolve until the server writes or closes, and a handler that waits for
  the client before answering deadlocks.  That is the medium, not the port.
- **A test double delivers on a later turn.**  A socket does, and a fake that delivers inside the subscription call
  hides exactly the window the adapters exist to hold.

### What is left

Slice 5, as the status line says: `Spawner` and `ClientSpawner` still name the frame channel, `oneConnection`
still exists, and `fromSpawner` is the shim that keeps it that way.  Nothing above the seam has to change when it
lands, which is what the port entry was for.
