# posipaki: a server reactor, with a unix socket as its first new listener

> **Status**: Draft proposal. No code written yet.

## Summary

Three servers in our own world wire the same thing by hand: the voice service's door, prsquare-sign's
`/ws` upgrade, and the operator console's fifo pair. Each takes connections from a transport, refuses or
admits them in the transport's own terms, and serves one actor per connection — and each writes that
loop itself, in a different idiom, over a different medium.

The proposal is one transport-agnostic piece for that loop, and the media that feed it:

```ts
// the reactor: accept, serve one actor per connection, say who arrived and who went
const reactor = reactor(listener, factory, { onSession, onClosed });

// a listener owns its medium and its own admission, and answers Connections
const listener = unixSocketListener({ path: "/run/dopje/console.sock", mode: 0o600 });
const listener = webSocketListener({ server, path: "/ws", identify });
```

Plus the client half of the one medium that is missing here, the unix socket, in the shape the websocket
pair already has.

## Motivation

**What the three servers share.**  All three: take a connection from a medium; decide in that medium's
terms whether to admit it (a token in an upgrade, a file mode, nothing at all); serve one actor for it,
spawned when the connection arrives; and keep, or deliberately do not keep, a registry of what is being
served.  Today each writes those four pieces by hand, and each gets a slightly different answer:

- the **voice server** (`email-agent`, `vendored/voice-server/src/listener.ts`) authenticates at the
  upgrade *before any actor exists*, then serves one `makeConnection(name)` per socket, with the resolved
  name arriving through a closure, and tells its router about the connection from inside the connection;
- **prsquare-sign** (`src/server/ws.ts`) serves one `JournalSession` per `/ws` connection with no
  admission step and no registry at all — its persistence is a store on disk;
- the **operator console** serves nothing itself yet: the terminal program serves the terminal and the
  console connects to it, one client at a time, over a fifo pair.

**What the reactor is for.**  A consumer should write the part it is about (the actor a connection
becomes, and what to do when one arrives or leaves) and nothing else.  The medium's own things — a token
in a query string, a socket's file mode or peer credentials — stay in the medium, in the listener; the
loop, the spawning, the registry of live sessions and the stop belong to the reactor.

**Why the socket comes with it.**  The console's medium is a fifo pair today, and the case that asks for
this work wants it replaced: an open order that is a handshake, one client at a time, a path a dead
client can poison, and a lifetime nobody owns.  A unix socket has none of those, and it is the medium
whose access control is a file mode.

## The reactor

```ts
/** What a listener hands the reactor: an admitted connection and whatever the transport knows about it. */
export interface Connection<Meta = unknown> {
  /** The transport's own facts: what `identify` resolved, the URL, the peer, the request. */
  readonly meta: Meta;
  /** The wire to the far side, ready to be served on. */
  readonly transport: StringTransport;
}

/** Where connections come from.  Transport-specific, and the only part that knows a medium. */
export interface Listener<Meta = unknown> {
  /** The next admitted connection.  Rejects once the listener is closed. */
  accept(signal?: AbortSignal): Promise<Connection<Meta>>;
  /** Stop taking connections and let the medium go (close a server, unlink a socket). */
  close(): Promise<void>;
}

/** One served connection, as the reactor reports it. */
export interface Session<Meta = unknown> {
  /** The served actor, as a process handle: the seam spawns it, so it is a root process here. */
  readonly proc: ServedProcess;
  /** What `identify` said, plus whatever the factory added. */
  readonly meta: Meta;
  /** Settles when the wire goes and the session is stopped. */
  readonly done: Promise<void>;
}

/** What a connection becomes: an actor, or an actor plus the meta the reactor should report. */
export type SessionFactory<Meta = unknown> = (
  connection: Connection<Meta>,
) => ActorDefinition | { actor: ActorDefinition; meta?: Meta };

export interface ReactorOptions<Meta = unknown> {
  /** A connection was admitted and its actor is up. */
  onSession?(session: Session<Meta>): void;
  /** Its wire went, and the reactor stopped it. */
  onClosed?(session: Session<Meta>): void;
}

export interface Reactor {
  /** Stop taking connections and stop every live session. */
  stop(): Promise<void>;
  /** How many sessions are being served right now. */
  readonly live: number;
}

export function reactor<Meta>(
  listener: Listener<Meta>,
  serve: ActorDefinition | SessionFactory<Meta>,
  options?: ReactorOptions<Meta>,
): Reactor;
```

The loop it runs, in words: `accept()`; build the channel and do the `$proto` handshake (the spawner's
job, done here so a consumer never writes it); call the factory with the connection; spawn the actor and
`serveRemoteActor` it; report it through `onSession`; when its wire goes — the seam stops the actor by
itself (`src/remote/server.ts:174`) — report it through `onClosed`; accept again.  `stop()` closes the
listener and stops every live session, so a client learns the server is gone from its wire closing.

A bare `ActorDefinition` is the sugar for a factory that ignores the connection and adds no meta.

## Listeners

The transport-specific half, and the place the two things a medium has and the reactor should not know
about live: **admission**, and **arguments that arrive with the connection rather than with the actor**.

```ts
export interface Upgrade<Raw = unknown> {
  /** The transport's own object: for a websocket, the request that asked to upgrade. */
  readonly raw: Raw;
  /** The URL, when the transport has one: where arguments ride. */
  readonly url?: URL;
}

export function webSocketListener<Meta = unknown>(options: {
  /** The HTTP(S) server whose upgrades become connections. */
  server: HttpServer;
  /** Which path upgrades; every upgrade when it is not given. */
  path?: string;
  /**
   * Admission and identity.  What it returns is the connection's meta; throwing refuses the
   * connection *before any actor exists*, which is the property the voice service's door has today.
   */
  identify?(upgrade: Upgrade<IncomingMessage>): Meta | Promise<Meta>;
}): Listener<Meta>;

export function unixSocketListener<Meta = unknown>(options: {
  /** The socket file.  Made when the listener starts, removed when it stops. */
  path: string;
  /** The mode of the socket file, set before anybody can connect.  Default 0o600. */
  mode?: number;
  /** Replace a path that refuses a connection (a crash's leftover); a non-socket path is refused. */
  replaceStale?: boolean;
  /** Admission and identity, and the peer credentials where the runtime gives them. */
  identify?(connection: { path: string; peer?: PeerCredentials }): Meta | Promise<Meta>;
}): Listener<Meta>;
```

What a listener does *not* do: frame anything (the transport's job), handshake `$proto` (the reactor's),
or know what an actor is.

## The client half, and the medium

A unix socket needs no new transport class.  `LineTransport` (`src/remote/stdio.ts`) already carries
newline-delimited JSON over a duplex stream, and a socket is one, so the client side is two functions and
a spawner:

```ts
/** Connect to a listener.  One call, and no open order: a socket is connected or it is not. */
export function connectUnixSocket(path: string, options?: { timeoutMs?: number }): Promise<LineTransport>;

/** The client half of the seam over a socket, as the websocket one is. */
export function socketClientSpawner<Args = unknown>(
  path: string | ((args: Args) => string),
  options?: { timeoutMs?: number },
): ClientSpawner<Args>;
```

Three media, one shape, which is the point: a transport, a listener on one side, a spawner on the other.

| medium | transport | listener (server) | spawner (client) |
| --- | --- | --- | --- |
| unix socket | `LineTransport` over the socket | `unixSocketListener` | `socketClientSpawner` |
| websocket | `WebSocketTransport` | `webSocketListener` | `wsClientSpawner` |
| stdio | `LineTransport` over the stream pair | — (a child process) | `fifoArgvSpawner`, `commandSpawner` |

## The three servers, on this API

**prsquare-sign** — what it writes today is a `WebSocketServer`, an upgrade handler and a
`WebSocketLike` adapter; what it would write:

```ts
reactor(webSocketListener({ server, path: "/ws" }), JournalSession);
```

No factory, no meta, no registry: the store on disk is the persistence, and each session is served as it
arrives.  (The node `ws` adapter moves into the listener, where every consumer of a websocket listener
needs it.)

**The voice server** — its door keeps the property that matters (nothing is spawned for a connection
that is not admitted) and loses its hand-written loop:

```ts
const listener = webSocketListener<{ client: string }>({
  server,
  path: "/ws",
  identify: ({ url }) => ({ client: tokens.resolve(url?.searchParams.get("token")) }),
});

reactor(listener, ({ meta }) => makeConnection(meta.client), {
  onSession: ({ proc, meta }) => router.send({ type: "CONNECTION_ANNOUNCED", conn: handleOf(proc), client: meta.client }),
  onClosed: ({ proc }) => router.send({ type: "CONNECTION_GONE", conn: handleOf(proc) }),
});
```

Two things stay the connection's own business: it mints the conversation's id, and it relays.  What moves
out of it is the announcement, which is now the reactor's report — and the report is a *handle*, not a
name, because two connections can carry the same client name (the connection's own comment says exactly
that) and because the seam spawns a served actor as a root process, so its name is the client's word for
it and not an identity.

**The operator console** — the harness accepts, and the fifo pair's whole vocabulary (the open order, the
release, one client at a time, `TerminalConnection`) goes:

```ts
const listener = unixSocketListener({ path: socketPath, mode: 0o600 });

reactor(listener, () => makeSession(consoleHandle), {
  onSession: ({ proc }) => console.send({ type: "CONSOLE_ATTACHED", client: handleOf(proc) }),
  onClosed: ({ proc }) => console.send({ type: "CONSOLE_DETACHED", client: handleOf(proc) }),
});
```

The console keeps what it already has: the `attached` list of terminals (now fed by the reactor's
reports, which arrive as messages, so the list still changes in a handler), the `CONSOLE_*` vocabulary,
presence, receipts, the command table and the layer split.  What it loses is its own connect loop, and
the terminal program becomes the client it always should have been —
`remoteClient("console", socketClientSpawner(path))` — which also makes several terminals possible at
once, a thing the console already supports and the fifo pair does not.

A run whose stdin is a terminal is not special: the console spawns the same terminal program as a child,
pointing it at the socket, and it arrives through the same listener as any other client.

## What this absorbs: the entry points that become sugar

If the reactor is the primitive, two things posipaki already ships are shorter forms of it, and should be
read that way — and reimplemented on it where that costs nothing.

- **`serveRemoteActor(def, spawner)`** is a reactor over a listener with exactly one connection.  The
  medium is whatever the spawner produces (a fifo, a socket somebody else accepted, a websocket that is
  already upgraded), the factory is the definition, and there is no registry because there is one session.
  Nothing changes for an existing caller; what is gained is that the same reporting is available to the
  one-connection case, where today a caller that wants the handle of what it serves has to get it from the
  actor itself.

  ```ts
  reactor(oneConnection(spawner), payloadDef, { onSession: ({ proc }) => ... });
  ```

- **`defineSubprocessActor(...)`** is the same thing over a listener whose medium is a child process: it
  spawns the command, the transport is the child's stdio (`LineTransport` over the stream pair, with the
  `$fd` output frames as they are today), `accept()` rejects when the child dies before it connects, and
  `close()` ends the child.  The rest of that bundle stays its own: staging the artifact, the host version,
  the wait for the exit, and the sentence a failed start comes back as.

  ```ts
  reactor(subprocessListener({ command, args, env }), payloadDef);
  ```

  The payload side reads the same way from the other end: a payload that serves its root over the wire it
  was handed is a one-connection reactor whose listener is that wire.

What this asks of a `Listener`, beyond a socket: `accept()` may reject for reasons that are the medium's
own (a child that died, a wire that closed), a listener may have exactly one connection and then be done,
and `close()` may own something with a lifetime (a child to end, a file to unlink).

## Generator, or emitter with a stop?

A generator is the wrong shape for a server, and the check is the loop body.  With
`for await (const connection of …)` the consumer's body has to return before the next accept, so a
session that is awaited inside the loop serializes every later connection, and one that is not awaited
moves the spawning, the registry and the stop back into the consumer — the three things the reactor is
for.  `serveRemoteActor` already gives each session a life of its own, so the reactor's loop keeps
accepting while sessions live, and the consumer's callbacks are notifications rather than the loop body.

The second candidate is the reactor as a *process*: an actor whose setup owns the listener, forks a child
per connection, and whose out-messages are "a session arrived" and "a session went".  It is the same API
with an actor around it, and it is the shape a console wants (state changes in a handler, and the
sessions visible in the tree).  It is deliberately *not* the primitive here: one of the three servers is
a plain program with no actor context, and `serveRemoteActor` spawns rootlessly, so a listener and a
reactor work from anywhere.  The wrapper is a dozen lines and belongs beside the reactor once a second
actor-shaped consumer wants it.

## What it does not do

- **No authentication of its own.**  Admission is the listener's `identify`, which for a socket means the
  file mode and the peer credentials, and for a websocket what the door already does with a token.  The
  reactor never sees a token, a URL or a file.
- **No reconnection.**  A wire that goes is a session that ends; a client that wants to come back
  connects again, which is a new session.
- **No TLS and no network sockets.**  A unix socket is local by definition; `net` could get the same
  treatment later, with a different set of questions (a port to secure).
- **No framing of its own.**  Newline-delimited JSON via `json1Channel`, as the fifo and stdio wires are.
- **No serving of a running process.**  What is served per connection is an actor the seam spawns.  A
  console is already running when a client arrives, so it serves a per-connection session that talks to
  it.  Serving a *running* actor would remove that session and needs a primitive posipaki does not have
  (`serveRemoteActor` spawns what it serves); it is worth its own proposal, and it is not needed for any
  of the three cases above.
- **No accept loop of its own at the transport layer.**  The reactor owns the loop; a listener only says
  what has arrived.

## Open

- **The name.**  `reactor` for the piece, `Listener` for the media, `identify` for admission.  The
  alternatives worth considering: `accept`/`Acceptor`, `admit`/`Admission`, `Session` vs `Served`.
- **Where the `$proto` handshake lives.**  This proposal puts it in the reactor (a consumer never writes
  it), which means a consumer that wants a different protocol needs a knob.  The alternative is that a
  listener hands back a spawner instead of a transport.
- **Whether the reactor reports only, or also answers.**  Today `onSession` is a notification.  A
  consumer that wants to refuse a connection *after* admission (the console with nobody attached
  refuses a delivery, not a connection) does it in the actor it serves, which keeps admission the
  listener's and policy the actor's.
- **The actor-shaped wrapper** (`reactorActor`: out-messages instead of callbacks), and whether it ships
  with this or with its first consumer.
- **Peer credentials on a socket.**  `SO_PEERCRED` gives uid, gid and pid on Linux; the listener should
  pass them in `identify` where the runtime exposes them, and say so where it does not.
- **Replacing a stale socket by default**, and whether `close()` unlinks only the inode it bound (it
  should).
- **Whether `serveRemoteActor` and `defineSubprocessActor` are reimplemented on this** or kept beside
  it: their extras (the `$fd` output frames, artifact staging, the wait for a child's exit) stay theirs.
- **Whether the fifo pair stays shipped** once a socket exists.  Every consumer that keeps both keeps
