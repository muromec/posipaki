# Ports: a channel, a spawner, an adapter

> **Status:** proposal, 2026-11-07; built in part, same day. The port entry, the process ports, the fetch client and the
> HTTP listener ship as **0.48.0**; the seam moving onto ports (slice 5) is the next release.
>
> **Built:** `posipaki/port` — `Channel<F, C>` with its three endings, the memory pair, the splitter, the byte
> channel over a stream pair, `held`, `all`/`settled`, `duplexChannel`, `portReactor`, `portActor`, and `fetchPort`
> for a response body. Nothing in this entry knows a protocol.
>
> `posipaki/port/node` — `spawnPort`/`spawnPorts` and the two actors over them (`BinaryPort`, `Utf8Port`), and
> `httpListener`, a `PortListener` whose requests arrive as pairs of ports.
>
> json.v1 and the handshake are adapters only this library's remote uses, so they live with it:
> `src/remote/protocols/json1.ts` and `src/remote/handshake.ts`, composed in `src/remote/seam.ts` as
> `handshake(json1(split(port, announced)))`. The remote is on it: the payload's fifo pair is a byte channel, and
> the serving half and every client spawner reach the protocol through the same chain. Both ends announce, which
> is a **behaviour change**: a peer that used to only listen now has to say what it speaks, or the handshake it is
> part of never finishes.
>
> **Not built, named as the next slice:** `Spawner` and `ClientSpawner` still name the frame channel — a
> spawner is a port internally, but its type says `Promise<Channel>`. So `StringTransport` and `json1Channel`
> survive inside the transports, the listeners still hand up a transport, and the seam composes over one
> rather than over a port. Moving those three types is the breaking half, and it lands when `Listener`
> returns a channel and `oneConnection` stops existing.
>
> The rest of the plan below stands: the sixteen frames, the reactor and both wire versions do not change,
> and this document supersedes the *Layers*, *Transport* and *Spawners* sections of
> [Remote Actors](actor-remote.md). It is also the channel that [xfetch as a pipe](xfetch-as-a-pipe.md)
> deferred when it said a stream wants one and called it "a different proposal".

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
// the seam, over any medium: the server end
const listener = await unixSocketListener({ path });          // Listener<Meta, Uint8Array>
const connection = await listener.accept();
const seam = handshake(json1(split(connection.channel)));     // Channel<Frame>
serveOn(seam, actor);

// the same seam, over ssh: a spawner, then the same two adapters
const bytes = await spawnOverSsh(host)(args);                 // Channel<Uint8Array>
const seam = handshake(json1(split(bytes)));                  // Channel<Frame>

// MCP: three adapters on a byte channel, and the third knows no medium
const server = mcp(jsonrpc(split(portChannel)));              // Channel<McpMessage>

// a port: a spawner, a channel, and the owner actor that holds one
const port = await this.fork(ProcessPort, { spawner: command('bun x'), args: [] });
```
`json1` is today's `json1Channel`, and it is the only place the version string appears.


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

## The owner

A channel is not a process. Something must hold it, hear its death, and stop what is underneath: the child, the
socket, the request. That is an actor, and it is built: `portActor` in `src/port/actor.ts`.

```ts
export interface PortPublic<C> {
  alive: boolean;   // the channel is open
  end: C | null;    // how it ended, and null until it has
}

portActor<Args, F, C>({ name, open(args): Promise<Channel<F, C>>, signal? });
```

In `SEND {data}` writes to the channel and `SIGNAL` reaches the medium through the spec; out is `DATA {data}` for
every frame. When the channel closes the actor writes `end`, clears `alive`, and stops — the ending is state, not
a message, because a parent reads state anyway and the death of the port is the death of the actor.

A spawner that starts a process closes over the kill in `channel.close()`, so the owner needs no second
vocabulary: closing the channel is stopping the thing. `close()` from our side is silence; the far side's close
arrives at `onClose`; a failure arrives at `onError` and then at `onClose`. Three endings, one channel.

The harness's process port is this: `BinaryPort` and `Utf8Port` in `src/port/node/process.ts`, over `spawnPort`.

## Way in: what a package exports

A medium is not a place. `ssh` is an argv prefix over the same child-process medium, `podman exec` is the
same with a container's lifetime around it, and `bwrap` the same inside a namespace. So the crossing is one
implementation in the core — `RemoteWayIn { name, entry, run?, spawn? }` is already that interface — and a
companion package is only what it alone can say: the argv, the spec, and the lifetime it owns.

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

Slices 1 and 2 of the list above, 2026-11-07:

- `src/port/channel.ts` — `Channel<F>`, `Part`, `ChannelClosed`.
- `src/port/memory.ts` — `memoryChannelPair()`, a channel with no medium, and the one ending a medium would
  discover for it (`fail`).
- `src/port/stream.ts` — `streamChannel({read, write})`, the byte channel a stdio pair, a fifo or a socket
  gives. A send settles once the stream has flushed the chunk, so the write side resists a writer that runs
  ahead of the reader.
- `src/port/split.ts` — `splitChannel(inner, announced?)`, bytes into parts, with the announcement travelling
  in as a question.

The spawners still run the whole stack themselves at this point; the commit that changes that is further down.

The encoding, 2026-11-07 (moved to `src/remote/protocols/json1.ts` when the remote came to use it):

- `src/remote/protocols/json1.ts` — the whole of json.v1 in one file: `json1(parts)`, a `Channel<Part>` as a
  `Channel<Delivered>`, where `Delivered` is the frame a line decoded to and the octets that line announced; the
  encoding both ways; and the `$bad` answer to a line nobody could read. One value rather than a frame plus a
  callback, so a chunk of a stream is one thing on the wire and `sendBytes`/`onBytes` have no counterpart above
  the splitter. `json1Channel` keeps the `StringTransport` path the stdio and gateway wires still use.

The handshake and the composition, 2026-11-07:

- `src/remote/handshake.ts` — `handshake(inner, {version, timeoutMs, onEarly, ready})`, the one adapter that is
  asynchronous: it resolves to the channel rather than returning one, because "the peer speaks what we speak"
  is what the caller needs before it talks. Silence, a wrong version, a peer that talks out of turn and a peer
  that leaves are rejections with a sentence each. Frames that arrive after the agreement and before anyone
  reads are held and handed to the first reader.
- `src/remote/pipeline.test.ts` — `handshake(json1(split(bytes, announced)))` on both ends of one pair of
  streams, over a medium that delivers on a later turn: a frame each way, octets through and back out
  unchanged, and the frame after a segment still in order. The announcement argument is the seam's
  (`announcedOctets`), which is why the composition names it.

The owner, and the spawners returning raw channels, are what is left.

The wrappers, and what the flip found, 2026-11-07:

- `src/remote/seam.ts` — `jsonSeam(spawner)` and `jsonSeamParts(spawner)`: a spawner that hands up a
  `Channel<Uint8Array>` or a `Channel<Part>` comes back as the seam's `FrameChannel`, with splitting,
  decoding and the agreement done above it. Two names rather than one that takes the frame type as an
  argument, because the frame type is the only thing that differs — and a caller reading `jsonSeamParts` does
  not have to work out what an argument would be. `frameChannel(delivered)` is the bridge: a close carries
  no reason upward, and a wire error is heard as the close that follows it, which is the shape
  `FrameChannel` has always had.
- **The handshake cannot be one-sided.** The reactor's protocol step sends `$proto` and reads none
  (`src/remote/reactor.ts:264`), while the port's handshake both announces and waits. A client that flipped
  on its own would have its `$proto` arrive where the serve expects `$init`, and be refused. So the spawners
  and `protocolStep` move in one commit, and slice 2 is one slice rather than two.

Flipping the fifo medium, first attempt, 2026-11-07 — attempted, and taken back out. Superseded by the
second attempt below; what it found is worth keeping:

- **The bridge has to fan out itself.** A subscription per kind is handed whatever the handshake held, and
  the filter that does not want it throws it away: a connection's `$init` went missing that way, and the
  payload answered `expected $init`. It is one reader on the port channel, a list per kind, and what
  arrived before a reader of that kind is kept for it (`4a415b6`).
- **Every consumer of a spawner flips with the spawner.** `serveRemoteActor(actor, fifoArgvSpawner)` is the
  far end of the handshake, so a payload written that way never says what it speaks; three fixtures had to
  become `serveRemoteActor(actor, () => jsonSeamParts(() => fifoArgvSpawner())(undefined))` before one real
  connection came up.
- **A hand-driven client announces too.** `server.integration.test.ts` drives a raw transport and sends no
  `$proto` of its own, which was correct against a server that only spoke first.

With those fixed, eight of the twenty reflection-integration cases still failed — lost method
announcements, one 20 s stall — which is the seam's reader timing rather than the medium. The flip was
taken back to the bridge commit instead of being patched to green at the end of a session; the next
attempt starts from `4a415b6`, with the reader order settled first.

The fifo flip, second attempt, 2026-11-07 — done for the payload path:

- **The medium hands up bytes.** `src/remote/spawners/fifo-port.ts` opens the pair and gives a
  `Channel<Uint8Array>` through `fifoByteChannel(readPath, writePath, "served" | "client")`.  Its one decision is
  which end to open first: the served side blocks on its write, the client on its read, as the line transport
  already did.
- `src/remote/spawners/fifo-argv.ts` and `fifo-command.ts` now compose `jsonSeam(...)` over that channel and
  build no frame themselves: no `json1Channel`, no `$proto` written by hand.
- **The reader order was the blocker** (`d828b7b`): what arrived before any reader existed was handed to
  whichever reader was there when the handshake let go, so the store got `$init` and `$r.methods` and dropped
  them. With it fixed, all nineteen reflection-integration cases pass over the flipped fifo and the gate is
  684 pass / 2 skip / 0 fail.
- Two tests spoke with one end only: `fifo-argv.test.ts` read the payload's `$proto` and answered nothing, and
  `server.integration.test.ts` sent `$init` without announcing. Both now announce, which is what a symmetric
  handshake costs a hand-driven peer.

Superseded by the next section: at this commit `fifoListener` and `fifoClientSpawner` still spoke with one end
only — the served side said `$proto` and read none — so a listener paired with `fifoClientSpawner` and nothing
else.  Every medium announces from both ends now.

Every medium on the port stack, 2026-11-07 (`02ac1e2`):

- `src/remote/seam.ts` gained `partsOf(transport)`: a line transport as `Channel<Part>`, holding a line until
  the octets it announced arrive, because the transport reports those as two calls and a part is one value.
  `seamOf(transport)` is the counterpart of `jsonSeam` for a medium that already frames itself.  It installs its
  readers before awaiting anything, because a socket can deliver a frame in the same turn the seam is composed.
- `handshake` gained `ready?: Promise<void>`, and the announcement waits for it.  A WebSocket needs it: the socket
  exists before it can send.
- `protocolStep` is a handshake, not a one-sided announcement. `fifoArgvSpawner`, `commandSpawner`,
  `fifoClientSpawner`, `socketClientSpawner`, `wsClientSpawner` and `wsServerSpawner` all compose the seam.

Two defects this shook out, both of the family of `d828b7b`: a frame lost between a medium becoming ready and a
reader being installed.

- composing the WebSocket seam *after* awaiting the open dropped the far end's `$proto`.  Fix: compose first, hold
  the announcement behind `ready`.
- `bunServerWebSocket` returned `readyState: ws.readyState`, a snapshot taken at the upgrade, so
  `WebSocketTransport.send` could refuse for the life of the connection with "not open".  Now a getter.

What it cost the tests: a hand-driven peer must announce.  `fifo-argv.test.ts`, `server.integration.test.ts`,
`websocket.test.ts`, `ws.integration.test.ts` and the reactor's fake transport all send `$proto` now.  The two ws
fakes deliver on a later turn, which is when a socket delivers.

The process port, and the two combinators, 2026-11-07:

- `src/port/channel.ts` — `Channel<F, C = string>`. `C` is what the far end says when it closes; `close()`
  still takes a sentence from this side, because the close we ask for is ours. The default keeps every existing
  channel as it was, and the adapters pass `C` through untouched: `splitChannel`, `json1`, `handshake`.
- `src/port/combine.ts` — `all(sources)` and `settled(sources)`, named after the promise pair because the choice
  is the same one. `all` tags every frame with the channel it came from and ends with the first ending; `settled`
  delivers every ending as a frame of its own and closes once all have. Neither sends: a frame put on a
  combination has no destination, so `send` rejects and says so.
- `src/port/node/spawn.ts` — `spawnPort(command, options)` and `spawnPorts(command, options)`, in the node entry.
  stdout is the channel's frames, stdin is what `send` writes, and `close()` ends stdin first and kills what is
  still there after `killAfterMs` (5 s by default). The close reason is `ProcessExit` — code and signal — and
  stderr is discarded unless `spawnPorts` was asked for, where it is a channel of its own that ends with the same
  exit. Erlang's ports are the model: data is a stream, the exit is a separate fact, and a child's stderr belongs
  to the child unless you ask for it.
- The harness's `src/port/port.ts` (BinaryPort/Utf8Port) is what this replaces: `Utf8Port` becomes
  `splitChannel(spawnPort(...))`, since the splitter already decodes. That move waits for this release to be
  published and pinned.

`held`, the one place that keeps frames, 2026-11-07:

- `src/port/held.ts` — `held(inner)`: frames that arrive while nobody is subscribed are kept, and every
  subscriber that arrives before the first delivery is given them. After the first delivery the channel is live
  and a later subscriber gets only what follows. Three copies of that rule lived in `handshake`, the process
  port and `frameChannel`; the first two now compose the adapter. `frameChannel` keeps its own because it holds
  two kinds of value apart — a frame and the octets it announced — which this adapter cannot express.
- The kept frames are not bounded: a bound depends on what the far end may say before anyone listens, which the
  adapter cannot know.

The port actor, 2026-11-07:

- `src/port/actor.ts` — `portActor({name, open, exit, signal?})`: one actor over one channel. In `SEND {data}`
  writes to the channel and `SIGNAL` reaches the medium through the spec; out `DATA {data}` per frame, and the
  spec's `exit(reason)` message once, after which the actor ends. The channel is opened in `afterStart` and closed
  in `beforeEnd`, so one life covers the other.
- `src/port/node/process.ts` — `BinaryPort` and `Utf8Port`, both `portActor` over `spawnPort`; the second puts
  `splitChannel` underneath so its frames are lines. Their exit message is `ENDED {code, signal}`, not `EXIT`:
  posipaki's own `EXIT` is the runtime's message about the actor ending, and two messages of one name on one
  stream is a trap the harness already paid for.
- `signal` is not wired in the two process ports yet: `spawnPort`'s channel has no way to reach the process, and
  stopping them is `close()` — stdin's end, then SIGKILL after the grace.

The ending is state, 2026-11-07:

- The port's ending is not a message. `PortPublic<C> = { alive, end: C | null }`: when the channel closes the
  actor writes `end`, clears `alive` and stops, so a parent reads it where it reads everything else.
- `portActor` therefore lost `exit()` and its message generic: the spec is `{name, open, signal?}`, and out is
  only `DATA`.
- `ProcessEnd` is two shapes, both of them the OS's own: `{kind: "exit", code}` or `{kind: "signal", signal}`.
  Measured: `kill -9` on a child gives `code: null, signal: "SIGKILL"`, `exit 7` gives `code: 7, signal: null`,
  and a kill we send after the grace is indistinguishable from a stranger's — so "we stopped it" could only
  come from our own bookkeeping, and was dropped.

The reactor at the port level, agreed 2026-11-07:

The connection reactor is a loop parameterised by a listener. The same loop belongs one level down, where the
medium is not a protocol but a pair of ports:

```ts
interface PortPair<In, Out, Meta> {
  readonly inbound: Channel<In, void>;    // what the far side sends
  readonly outbound: Channel<Out, void>;  // what we send back
  readonly meta: Meta;
}

interface PortListener<In, Out, Meta> {
  accept(): Promise<PortPair<In, Out, Meta>>;
  close(): Promise<void>;
}

portReactor(listener, handle, { onSession, onClosed, onError }): { live, stop() }
```

A pair is the general form, and every medium fits it: a WebSocket's inbound is its `onmessage` and its outbound is
`send`; an HTTP request's inbound is the request body and its outbound is the response body; a fifo is the same
pair over bytes. What differs is what a frame is, which is the adapter's business:

| Medium | inbound/outbound frame | Adapter above it |
| --- | --- | --- |
| WebSocket | `string`, already a line | `json1` (no splitter) |
| fifo, socket, HTTP body | `Uint8Array` | `splitChannel`, then `json1` |
| no protocol at all | whatever the handler wants | none |

Three levels, and each owns one thing:

1. the **listener**: admission before anything is created, refusal in the medium's words, one accept at a time;
2. the **port reactor**: the loop, one handler per pair, the live set, `stop()`;
3. the **actor reactor**: one actor per accept, reported as a session, stopped with the pair — and it takes the
   adapter as a parameter rather than building one, so `serveRemoteActor` is this reactor with `jsonSeam` and an
   HTTP handler is the same reactor with nothing.

The client side is the same sentence the other way round: a spawner gives a channel and `remoteClient` puts an
actor on it; a listener gives a pair and the actor reactor puts an actor on it.

Built after this section was written: `httpListener` hands `{request, meta, response}` today, which is the pair
minus the request body; the refit gives it an inbound port and moves the loop into `portReactor`.

The HTTP pair and the duplex adapter, 2026-11-07:

- `src/port/fetch.ts` — `fetchPort(url, options)`: a response body as a channel.  Chunks as they arrive, `close()`
  aborts (the far side hears it), the ending is `{status}`, and a non-2xx or a dead connection rejects before a
  channel exists.  `connectMs` bounds the response head and nothing else; a stream may be long.
- `src/port/node/listener.ts` — `httpListener` is a `PortListener<Uint8Array, Uint8Array, Meta>`: a request arrives
  as a pair, its body inbound and its answer outbound, and the `Response` is built in the listener.  `identify`
  runs before a pair exists, so a refusal is a 401 with the sentence and costs no stream.
- `src/port/reactor.ts` — `portReactor(listener, handle, options)`: the loop, one handler per pair, `live` and
  `stop()`.  The listener keeps admission and the medium; the launch of a handler and its reporting are the
  reactor's, as they are for connections.
- `src/port/duplex.ts` — `duplexChannel({inbound, outbound})`: a pair read as one channel, which is what an actor
  is written against.  The composition above a pair is `duplexChannel` → `splitChannel` (only for byte media) →
  `json1` → `handshake` → an actor; `seamOf` is that with one line in front of it.

One fact the tests forced out: a client's response head arrives with the first frame the handler writes, because
that is how HTTP works.  `await fetchPort(url)` therefore does not resolve until the server writes or closes, and
a handler that waits for the client before answering deadlocks.  That is the medium, not the port.
