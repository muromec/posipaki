# The Connection Both Ends Hold

**Status:** draft

## Motivation

One object already speaks the frames: `Channel` (channel.ts:26), with `send`, `onMessage`,
`removeHandler`, `onClose` and `close`; both halves of the remote layer hold one (`client.ts:76`,
`server.ts:84`).  What is not symmetric is who gets to use it.

**The client end reaches it, the serving end does not.**  On the client the proxy process holds
the channel in its private state (client.ts:76), so nothing else in that process tree can reach
the connection.  On the serving side the channel is wrapped into `ServedConnection.output(fd,
data)` (reactor.ts:34-41) and handed to the session *factory* (reactor.ts:130-141), not to the
process being served.  A served actor therefore cannot put anything on its own connection that
is not a frame about a process.

**The far end's own output sits below the frame layer, and each side names it differently.**  The
client strips `$fd` lines in the transport with `OutputFilter` (stdio.ts:233-265), before the
protocol step sees them (stdio.ts:314, `spawners/socket-client.ts:25`), because the first frame
of a session must be the peer's `$proto` (stdio.ts:16-19).  The serving side writes `{$fd: fd,
data}` by hand (reactor.ts:134).  Two options carry a sink, one per side: `onOutput` on
`ClientChannelOptions` (stdio.ts:297-302), on `SocketClientOptions`
(`spawners/socket-client.ts:12-15`), and on `GatewayClientOptions`
(`gateway-client.ts:113-114`).

What this costs: a program served over a connection cannot write to the terminal attached to it,
and the terminal's bytes have to be invented as messages.  `$fd` is not in the frame vocabulary
the server dispatches (channel.ts); it lives in the transport, on one side only.

## Design

### One interface, held by the process at each end

`Channel` is already the shape.  What changes is who holds it: the process itself, as
`ctx.connection: Channel | null`, set from a spawn option.

```ts
const child = await definition.spawn(args, { connection });
// inside the process: this.ctx.connection
```

The same route `parentName` and `parentId` took (see
[Parent Identity on ProcessCtx](parent-identity-on-ctx.md)): the spawner states it, the process
reads it, and a process with no connection reads `null`.

The remote layer states it for the root of each end: `remoteClient`'s proxy (client.ts:98) and the
process `serveChannel` serves (server.ts:188).  `spawnFactory` (reactor.ts:70) passes it into the
spawn options, so the plain `reactor(listener, actor)` path needs no caller code.  A factory that
spawns for itself does the same thing explicitly.

`ServedConnection` (reactor.ts:34-41) keeps the admitted connection and loses `output`; the reactor
stops building the wrapper (reactor.ts:130-135) and hands on what it has.

### `$fd` is a frame of the connection

The kind moves into the frame vocabulary (channel.ts) with the shape it has today,
`{"$fd": 1 | 2, "data": "…"}`, and `0` joins it: the direction a program calls its input.  One
kind, three numbers, and a stream is duplex rather than output-only.

Routing is a layer above the channel, on both ends: a frame that is `$fd` goes to that end's sink,
every other frame goes on exactly as it does now.  The `$proto` handshake reads *past* output
frames instead of being protected from them by the transport, which is what removes the filter
without reopening the mistake it prevented (a payload's own print taken for protocol,
stdio.ts:12-14).

```ts
const streams = fdStreams(connection, { sink: stderrSink() });
streams.send(1, "hello\n");                  // the far end's stdout
streams.onData(0, (chunk) => feed(chunk));   // its stdin
connection.onClose(() => streams.closeAll());
```

Deleted by this: `OutputFilter` (stdio.ts:233-265), `parseOutputFrame`'s place in the transport
(stdio.ts:248-251), the three `onOutput` options, `ServedConnection.output` and the reactor's
wrapper.

### Byte streams above that

`fdStream(connection, fd)` is the thin adapter: write bytes, read bytes, on one number.

```ts
const out = fdStream(connection, 1);
out.write("ready\n");
```

It exists so that the shape has one home instead of one per caller: a payload's own output is
forwarded by hand today (`gateway.ts:114-122`), and every served program that prints has to
invent the same loop.

What it does not promise: no backpressure beyond the channel's own, no framing beyond what a
frame carries, no multiplexing of several processes on one connection.

## What it does not do

- One connection stays one root.  `$fd` is about the connection's root; a deeper process that
  needs streams of its own gets its own connection.
- No change to the order of `$proto` and `$init`: a frame may arrive at any moment, and the
  handshake skips the ones that are not the protocol's.
- No answer yet for a child that is handed the same connection as its parent; see Open.

## Open

- Does a forked child inherit `ctx.connection`?  Addressing is not the obstacle (a frame carries
  `to`); the question is whether two processes may speak over one connection, and what that does
  to `$tune` and to the streams of each.
- Does fd 0 need its own kind, or is one `$fd` kind with three numbers enough?  The proposal above
  says one, because a stream's two directions belong together.
- Which end's sink is the default when a caller names none.  The client end defaults to stderr
  today (stdio.ts:314); a served process should probably have no default and print nothing until
  a sink is named.

## Implementation

One commit per slice, each with its own tests.

1. `ctx.connection` and the `connection` spawn option; `remoteClient` sets it on its proxy;
   `serveChannel` passes the channel to the factory; `ServedConnection.output` is derived from it,
   so nothing changes for a caller.
2. `$fd` above the channel on the client end: the sink belongs to the connection, `OutputFilter`
   goes, and the handshake skips frames that are not the protocol's.
3. The serving end writes `$fd` through the connection; `ServedConnection.output` and the
   reactor's wrapper go.
4. `0` in the frame vocabulary, `fdStreams` and `fdStream`, with tests on both ends (a served
   process writing while its client reads, bytes the other way, a close that ends both).
5. Callers move over: the gateway's forwarding loop (gateway.ts:114-122) first, then programs
   outside this repository.

## Compatibility

`ServedConnection.output` and the three `onOutput` options were published in 0.43.0, so removing
them costs one minor version (0.44.0) and no compatibility shim.
