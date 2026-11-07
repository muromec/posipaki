# Ports: a channel, a spawner, an adapter

> **Status:** proposal, 2026-11-07. **Breaking:** `StringTransport` goes, `Spawner` and `Listener` return
> the channel a medium actually gives, and the seam's framing moves above the spawner. Lands as **0.48.0**
> on a 0.x line, as a second entry point — `posipaki/port` — beside `posipaki/remote`, and with no
> dependency between the two beyond the remote's use of it. This document supersedes the *Layers*,
> *Transport* and *Spawners* sections of [Remote Actors](actor-remote.md); the sixteen frames, the reactor
> and both wire versions do not change. It is also the channel that [xfetch as a pipe](xfetch-as-a-pipe.md)
> deferred when it said a stream wants one and called it "a different proposal".

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
/** Frames of one type, and the three ways it ends. */
export interface Channel<F> {
  send(frame: F): Promise<void>;
  /** A frame arrived.  The returned function stops this reader and no one else. */
  onFrame(handler: (frame: F) => void): () => void;
  /** The far side closed, with whatever it said.  Once, after any frames already read. */
  onClose(handler: (reason: string) => void): void;
  /** The wire failed.  Once, and always followed by a close. */
  onError(handler: (error: unknown) => void): void;
  /** Close it from this side.  Idempotent; the far side hears a close of its own. */
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

A channel is not a process. Something must hold it, hear its death, and kill what is underneath: the child,
the socket, the request. That is an actor, and it is the layer this document names rather than builds:

```ts
/** One actor: the channel it holds, and the reason it ended. */
interface OwnedChannel<F> {
  channel: Channel<F>;
  /** Settles when the far end is gone and everything under it has been released. */
  done: Promise<{ reason: string }>;
}
```

A spawner that starts a process closes over the kill in `channel.close()`, so the owner needs no second
vocabulary: closing the channel is stopping the thing. `close()` from our side is silence; the far side's
close arrives at `onClose`; a failure arrives at `onError` and then at `onClose`. Three endings, one
channel.

This is also where the harness's process port belongs: it is a spawner over a child's stdio plus an owner,
which is `spawners/command.ts` beside the `stdio.ts` and `process-streams.ts` already here.

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
- **A close carries a sentence, not a code.** A process that fails after connecting has its failure in the
  close reason (`exit 127: …`, with the tail of what it printed), because the exit is a fact about the child
  and only the spawner that started it knows one. A channel that understood process exits would stop being a
  channel.
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
6. **The owner.** `process-streams.ts` and `stdio.ts` grow into a spawner over a child, and the harness's
   process port moves here.
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
- **Does the owner belong here or beside it?** It is one actor over a channel, with no knowledge of any
  medium, which argues for this library. It is also the only place a kill policy lives, which argues for
  whoever knows what is being killed.
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

The spawners still run the whole stack themselves, so nothing in `posipaki/remote` is on this yet.

The encoding, 2026-11-07:

- `src/port/json1.ts` — `json1(parts)`, a `Channel<Part>` as a `Channel<Delivered>`, where `Delivered` is the
  frame a line decoded to and the octets that line announced. One value, so a chunk of a stream is one thing
  on the wire rather than a frame plus a callback, and `sendBytes`/`onBytes` have no counterpart above the
  splitter. The `$bad` answer to a line nobody could read lives here too, and `posipaki/remote` re-exports it.

The handshake and the composition, 2026-11-07:

- `src/port/handshake.ts` — `handshake(inner, {version, timeoutMs, onEarly})`, the one adapter that is
  asynchronous: it resolves to the channel rather than returning one, because "the peer speaks what we speak"
  is what the caller needs before it talks. Silence, a wrong version, a peer that talks out of turn and a peer
  that leaves are rejections with a sentence each. Frames that arrive after the agreement and before anyone
  reads are held and handed to the first reader.
- `src/port/pipeline.test.ts` — `handshake(json1(split(bytes, announced)))` on both ends of one pair of
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
