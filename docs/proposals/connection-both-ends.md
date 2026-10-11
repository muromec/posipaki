# The Connection Both Ends Hold

**Status:** draft, reworked 2026-10-11 after master's rulings.  Built: the frames have names and one
exported type (`dbe75a8`), `$fd` is a frame of the connection with fd 1 and 2 (`12c51fb`, `11b616e`),
and the connection is the process's own fact at both ends (`ctx.connection`, `771bf87`).  Not built:
the channel on the session report and on the client's connection (the two hooks below), the fan-out
behind `onMessage`, fd 0, and the byte streams.

## Motivation

One object already speaks the frames: `Channel` (`channel.ts`), with `send`, a subscription for the
frames that arrive, `onClose` and `close`; both halves of the remote layer hold one (`client.ts:76`,
`server.ts:84`).  What is not symmetric is who gets to use it.

**The code that starts a connection cannot reach it.**  The reactor builds the channel per connection
(`reactor.ts:129-131`) and hands it to the session factory as `ServedConnection.channel`
(`reactor.ts:136-146`); `spawnFactory` passes the same channel to the process it spawns, as
`ctx.connection` (`reactor.ts:78`).  The reactor's own report, the only thing its starter sees, is
`Session = { proc, meta, done }` (`reactor.ts:152`); `onIncomingFrame` is the one frame that starter
ever hears, and it cannot send at all.  On the client side the channel is the spawner's return value
(`ClientSpawner`, `client.ts:45`), taken inside the proxy's setup (`client.ts:100`) and kept privately
and as `ctx.connection` (`client.ts:103`): whoever called `remoteClient` sees neither.

So a terminal's endpoint, a registry, a log sink — anything whose job is to serve the connection it
just admitted — can read frames and cannot send them, and on the client end can do neither.

## Design

### The two places a starter gets the channel

Master's ruling: "we both client and server should have exposed the way to send and receive the frames.
I only remember the callback on the reactor, which is 1 out of 4 positions in the matrix."  The four
positions are `channel.send` and a subscription to `channel` at each end.  Two of them are additions:

```ts
reactor(listener, factory, {
  onSession(session) {
    session.channel.send(outputFrame(1, "ready\n"));            // out
    const off = session.channel.onMessage((frame) => {});        // in
    return () => off();                                          // run when the session is over
  },
});

const agent = remoteClient("agent", spawner, {
  onChannel(channel, ctx) {
    return channel.onMessage((frame) => {});   // one subscription: the unsubscribe is the cleanup
  },
});
await agent.spawn({});
```

Both hooks may return a cleanup, awaited at the session's end and by `stop()` on the server, and when
the wire goes or the proxy stops on the client.  The pair composes, because `onMessage` returns the
same shape: a hook that wants one reader is `return channel.onMessage(handler)`.

`Session` carries the channel (`reactor.ts:152`); `onClosed` stays as it is, reporting the same moment
to a starter that did not subscribe there.

### `onMessage` is a subscription

The serve's dispatch, a session's own reader, the far end's output, a terminal's log stream: everything
above the transport that wants frames is a subscriber.  `json1Channel` keeps the set and installs one
handler on the transport, because the transports are single-handler by contract and throw on a second
one (`websocket.ts:50`, `fifo.ts:128`, `stdio.ts:125`, `worker.ts:55`).  `Channel.removeHandler` goes
with that: an unsubscribe is what a subscriber has.

### `$fd` is a frame of the connection

Master's ruling: "fd forwarding isn't process bound. it's something on the reactor/connector level".
`$fd` left the transport and is a frame like any other:

```json
{ "$fd": 0, "data": "…" }   // the sending root's input
{ "$fd": 1, "data": "…" }   // the sending root's own output
{ "$fd": 2, "data": "…" }   // the sending root's errors
```

One kind and three numbers, not three kinds: a stream's two directions belong together, and fd 0 is
the direction a program reads.  The fd belongs to the root that sent the frame, so each end reads what
the other one's root prints and writes what its own prints.

Routing is a layer above the channel at both ends: a frame that is `$fd` goes to that end's streams,
every other frame goes on to the seam.  The `$proto` handshake reads past output frames instead of
being protected from them (`OutputFilter`, `stdio.ts:233-265`, goes), which is what makes one channel
carry both.

### Byte streams above that

Master's ruling: "lets use node streams.  think how it plugs into the logger."  So the streams are
node's, they live in `remote/node` (`src/remote/streams.ts`), and they are the one home for a shape
every caller writes by hand today (`forwardOutput`, `gateway.ts:114-122`):

```ts
export interface FdSet {
  readonly stdin: FdStream;   // 0
  readonly stdout: FdStream;  // 1
  readonly stderr: FdStream;  // 2
  close(): void;
}

export interface FdStream {
  /** The other end's root, printing on this fd of its own. */
  readonly read: Readable;
  /** This end's root, printing on this fd; the other end reads it. */
  readonly write: Writable;
}

export function fdStreams(channel: Channel): FdSet;
```

Both directions on one fd, because both ends have a root and each reads what the other prints: the
server that serves a terminal writes its own fd 1 to show a line, and the terminal reads that line as
the other root's fd 1.  One object, no per-end special case.

The logger plugs in where a stream ends, as a `Writable` — the debug logger's own shape is
`LoggerFactory = (name) => Logger`, so the name it was built with is the name the lines arrive under:

```ts
/** A writable that turns chunks into log lines: fd 1 to info, fd 2 to warn, and the tail held until a newline. */
export function logStream(log: Logger, opts?: { fd: 0 | 1 | 2 }): Writable;

onChannel(channel) {
  const fds = fdStreams(channel);
  fds.stdout.read.pipe(logStream(log));   // what the far end prints, into this process's log
  return () => fds.close();
}
```

The same path runs the other way: `fds.stdout.write("line\n")` is an output frame, so what a program
prints here arrives there as the stream its logger reads.

What the streams do not promise: no backpressure beyond the channel's own `send`, no multiplexing of
several processes on one connection, no pty semantics.

## What it does not do

- One connection stays one root per side.  A deeper process that needs streams of its own gets its own
  connection; whether a forked child may inherit `ctx.connection` is open.
- No change to the order of `$proto` and `$init`: a frame may arrive at any moment and the handshake
  skips the ones that are not the protocol's.
- No default sink.  A caller names where the far end's output goes; a process that names none prints
  nothing.

## Open

- Which end's sink is the default when a caller names none (the client end defaults to stderr today,
  `stdio.ts:314`; the model above removes that default rather than moving it).
- Whether fd 0 is also read by a `Writable` on the other side, or the input direction is only ever a
  `Readable` in practice.
- Whether `stdin`/`stdout`/`stderr` are the right names for a *connection's* roots, given that
  "stdout" here means both "what this root prints" and "what the other root printed".

## Implementation

One commit per slice, each with its own tests, gate green.

1. `Session.channel`, `onSession`'s cleanup, `remoteClient`'s `onChannel` and its cleanup.  (`reactor.ts`,
   `client.ts`, the index.)
2. `onMessage` returns its unsubscribe; the fan-out lives in `json1Channel`; the callers that used
   `removeHandler` give up their own entry (`server.ts:348`, `reactor.ts:266`, `output.ts:42`, the three
   client spawners, `stdio.ts`, `fifo.ts`).
3. `$fd: 0` in the vocabulary, and `fdStreams` with `logStream` in `remote/node`.
4. Callers move over: the gateway's forwarding loop (`gateway.ts:114-122`) first.

## Compatibility

`ServedConnection.output` and the three `onOutput` options were published in 0.43.0, so removing them
costs one minor version (0.44.0) and no compatibility shim.  `Channel.removeHandler` goes in the same
version: `onMessage`'s unsubscribe replaces it, and both are one line at each call site.
