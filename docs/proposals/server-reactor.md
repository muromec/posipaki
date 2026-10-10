# posipaki: a server reactor, with a unix socket as its first new listener

> **Status**: Draft proposal. No code written yet.

## Summary

Every server that serves actors over a wire writes the same loop by hand: take a connection from a
transport, admit or refuse it in the transport's own terms, serve one actor for it, and keep or not keep a
registry of what is being served.  The shapes it takes are the same whether the medium is a socket, a
websocket or a pair of named pipes, and so are the mistakes.

The proposal is one transport-agnostic piece for that loop, and the media that feed it:

```ts
// the reactor: accept, serve one actor per connection, say who arrived and who went
const reactor = reactor(listener, factory, { onSession, onClosed });

// a listener owns its medium and its own admission, and answers Connections
const listener = unixSocketListener({ path: "/run/service.sock", mode: 0o600 });
const listener = webSocketListener({ server, path: "/ws", identify });
const listener = fifoListener({ read, write }); // one connection per lifetime
const listener = subprocessListener({ command, args }); // the child is the connection
```

Plus the pieces the media are missing: the unix socket end to end (`LineTransport` over the socket, its
listener and its client spawner), a listener for a fifo pair that already exists, and the one-connection
and subprocess listeners that turn `serveRemoteActor` and `defineSubprocessActor` into sugars over this.

## Motivation

**What every such server shares.**  Each takes a connection from a medium; decides in that medium's terms
whether to admit it (a token in an upgrade, a file mode, nothing at all); serves one actor for it, spawned
when the connection arrives; and keeps, or deliberately does not keep, a registry of what is being served.
Each writes those four pieces by hand today, and each gets a slightly different answer:

- one admits by a token at the upgrade, *before any actor exists*, then serves one actor per socket, with
  the resolved name arriving through a closure, and tells a registry about the connection from inside the
  connection;
- one serves a session per connection with no admission step at all and keeps no registry: its state is a
  store on disk rather than an actor;
- one's medium is a pair of named pipes, whose open order is a handshake and which carries one client per
  lifetime, so its accept loop and the release of a pending wait are written by hand in the consumer.

**What the reactor is for.**  A consumer should write the part it is about (the actor a connection
becomes, and what to do when one arrives or leaves) and nothing else.  The medium's own things — a token
in a query string, a socket's file mode or peer credentials — stay in the medium, in the listener; the
loop, the spawning, the registry of live sessions and the stop belong to the reactor.

**Why the socket comes with it.**  The medium that asks for this work is a pair of named pipes, and what it
costs is a list: an open order that is a handshake, one client at a time, a path a dead client can poison,
and a lifetime nobody owns.  A unix socket has none of those, and it is the medium whose access control is
a file mode.

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
   * connection *before any actor exists*, which is the property a token-admitting door needs.
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
export function fifoListener<Meta = unknown>(options: {
  /** The two paths: lines arrive on `read`, and what this side says goes out on `write`. */
  read: string;
  write: string;
  /** Make the pair when it is missing, and refuse a path that exists and is not a fifo. */
  make?: boolean;   // default true
  identify?(connection: { read: string; write: string }): Meta | Promise<Meta>;
}): Listener<Meta>;
```

A fifo pair is the one-connection listener that is not hypothetical: a pair is one wire, so the medium
gives exactly one client per lifetime, and `accept()` resolves once and then the listener is done.  The
open order that makes a pair meet (the read end is opened only once somebody is writing, which is why
`FifoUtf8NlineTransport` has `beginConnect` and `connect` at all) is the listener's business rather than
the consumer's, and `close()` releases a wait that is still pending.  A second client means a second pair,
and that is the medium's property rather than the reactor's, so "one at a time" stops being something a
consumer's own code has to enforce.

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

/** The other half of a pair: connect to one that already exists, and do the handshake. */
export function fifoClientSpawner<Args = unknown>(
  paths: { read: string; write: string } | ((args: Args) => { read: string; write: string }),
): ClientSpawner<Args>;
```

Every medium the seam has, in one shape: a transport, a listener on the serving side, and a spawner on
the connecting side.  Only the medium's own facts differ, and only its listener knows them.

| medium | transport | listener (the serving side) | spawner (the connecting side) |
| --- | --- | --- | --- |
| unix socket | `LineTransport` over the socket | `unixSocketListener` | `socketClientSpawner` |
| websocket | `WebSocketTransport` | `webSocketListener` | `wsClientSpawner` |
| fifo pair | `FifoUtf8NlineTransport` | `fifoListener` (one connection per lifetime) | `fifoClientSpawner` (a pair that exists), `fifoArgvSpawner` (a pair it makes, for a child) |
| stdio | `LineTransport` over the stream pair | `subprocessListener` (it spawns the child) | `runRemoteRoot` (the payload side) |

The pair's client half is the one that is missing today: posipaki connects to a pair only when it spawned
the child holding the other end (`fifoArgvSpawner`, `commandSpawner`), and a pair somebody else made has no
spawner of its own.  `fifoClientSpawner` is the five-line counterpart, over the `connect` the transport
already has.

## Three shapes a server takes, on this API

**A session per connection, and nothing kept.**  What such a server writes today is a listener, an upgrade
handler and a socket adapter; what it would write:

```ts
reactor(webSocketListener({ server, path: "/ws" }), Session);
```

No factory, no meta, no registry: its persistence is a store on disk, and each session is served as it
arrives.

**Admission at the door, and a registry reached by reference.**  What matters is kept — nothing is spawned
for a connection that is not admitted — and the hand-written loop goes:

```ts
const listener = webSocketListener<{ client: string }>({
  server,
  path: "/ws",
  identify: ({ url }) => ({ client: tokens.resolve(url?.searchParams.get("token")) }),
});

reactor(listener, ({ meta }) => makeSession(meta.client), {
  onSession: ({ proc, meta }) =>
    registry.send({ type: "SESSION_OPENED", session: handleOf(proc), client: meta.client }),
  onClosed: ({ proc }) => registry.send({ type: "SESSION_CLOSED", session: handleOf(proc) }),
});
```

The session keeps what is its own: it mints the conversation's id, and it relays.  What moves out of it is
the announcement, which is now the reactor's report — and the report is a *handle*, not a name: the seam
spawns a served actor as a root process, so its name is the client's own word for it rather than an
identity, and two connections can carry the same one.

**A pair of named pipes, one client per lifetime.**  The medium's whole vocabulary (the open order, the
release, one client at a time) is written by hand today; here it is the listener's, and the consumer's code
is the same call as the two above:

```ts
reactor(fifoListener({ read, write }), () => makeSession(registryHandle), {
  onSession: ({ proc }) => registry.send({ type: "SESSION_OPENED", session: handleOf(proc) }),
  onClosed: ({ proc }) => registry.send({ type: "SESSION_CLOSED", session: handleOf(proc) }),
});
```

What such a consumer keeps is its own list of what is attached, now fed by the reactor's reports; because
those arrive as messages, the list still changes in a handler.  What it loses is its connect loop, the
release and the one-at-a-time rule.  A client that is a program run as a child, pointed at the same path,
is not special: it arrives through the same listener as any other.

The same call, with a different listener, is also what a named-pipe consumer runs **today**, written by
hand.  That is the consequence worth keeping in view: the media differ and the reactor does not, so moving
from a pair to a socket is a new listener and almost nothing else.
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
with an actor around it, and it is the shape a consumer with state wants (changes in a handler, and the
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
  long-lived actor that is already running must therefore serve a per-connection session that talks to it,
  rather than being served itself.  Serving a *running* actor directly would remove that session and needs
  a primitive posipaki does not have (`serveRemoteActor` spawns what it serves); it is worth its own
  proposal, and it is not needed for any of the three shapes above.
- **No accept loop of its own at the transport layer.**  The reactor owns the loop; a listener only says
  what has arrived.

## Open

- **The name.**  `reactor` for the piece, `Listener` for the media, `identify` for admission.  The
  alternatives worth considering: `accept`/`Acceptor`, `admit`/`Admission`, `Session` vs `Served`.
- **Where the `$proto` handshake lives.**  This proposal puts it in the reactor (a consumer never writes
  it), which means a consumer that wants a different protocol needs a knob.  The alternative is that a
  listener hands back a spawner instead of a transport.
- **Whether the reactor reports only, or also answers.**  Today `onSession` is a notification.  A
  consumer that wants to refuse *after* admission does it in the actor it serves, which is where a refusal
  of a *delivery* rather than of a connection belongs: admission stays the listener's and policy the
  actor's.
- **The actor-shaped wrapper** (`reactorActor`: out-messages instead of callbacks), and whether it ships
  with this or with its first consumer.
- **Peer credentials on a socket.**  `SO_PEERCRED` gives uid, gid and pid on Linux; the listener should
  pass them in `identify` where the runtime exposes them, and say so where it does not.
- **Replacing a stale socket by default**, and whether `close()` unlinks only the inode it bound (it
  should).
- **Whether `serveRemoteActor` and `defineSubprocessActor` are reimplemented on this** or kept beside
  it: their extras (the `$fd` output frames, artifact staging, the wait for a child's exit) stay theirs.
- **Whether the fifo pair stays shipped** once a socket exists.  Every consumer that keeps both keeps
