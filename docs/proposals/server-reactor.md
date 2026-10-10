# posipaki: a server reactor, with a unix socket as its first new listener

> **Status**: The reactor, the unix socket listener and client spawner, `oneConnection`, and the fifo listener
> and client spawner are built and tested; `serveRemoteActor` is a one-connection reactor, and the subprocess
> spawners below `defineSubprocessActor` are re-expressed on the pair's client half.  Not built: the websocket
> listener, the host-running path's `$fd` frames, and the reactor-as-actor wrapper.

## Summary

Every server that serves actors to a remote caller writes the same loop by hand: take a connection from a
transport, admit or refuse it in the transport's own terms, serve one actor for it, and keep or not keep a
registry of what is being served.  The shapes it takes are the same whether the medium is a socket, a
websocket or a pair of named pipes.

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
listener `serveRemoteActor` is built on.

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
/** The way in: a transport the reactor runs the protocol step on, or a channel already through one. */
export type Incoming =
  | { readonly transport: StringTransport; readonly channel?: undefined }
  | { readonly channel: Channel; readonly transport?: undefined };

/** What a listener hands the reactor: an admitted connection and whatever the transport knows about it. */
export type Connection<Meta = unknown> = Incoming & {
  /** The transport's own facts: what `identify` resolved, the URL, the peer, the request. */
  readonly meta: Meta;
};

/** Where connections come from.  Transport-specific, and the only part that knows a medium. */
export interface Listener<Meta = unknown> {
  /** The next admitted connection.  Rejects once the listener is closed. */
  accept(signal?: AbortSignal): Promise<Connection<Meta>>;
  /** Stop accepting, and release what the listener owns: a server, a socket file, a child, a wait. */
  close(): Promise<void>;
}

/** One served connection, as the reactor reports it. */
export interface Session<Meta = unknown> {
  /** The process being served, as a handle: whichever side of the connection spawned it. */
  readonly proc: ServedProcess;
  /** What `identify` said, plus whatever the factory added. */
  readonly meta: Meta;
  /** Settles when the connection closes and the session is over. */
  readonly done: Promise<void>;
}

/** What the far side stated when it opened the connection: the args it asks to be spawned with, and its own
 *  name for its end of the connection. */
export interface Init<Args = unknown> {
  readonly args: Args;
  readonly rootName: string;
  readonly parentName: string | null;
  readonly parentId: symbol | null;
}

/** What a factory answers: the process to serve, and what the reactor has to know about it. */
export interface Served<Meta = unknown> {
  readonly proc: ServedProcess;
  /** What the factory resolved, when it has more to say about the session than the connection did. */
  readonly meta?: Meta;
  /**
   * What ends this session: run once, when the connection closes and when the reactor stops.  It defaults to
   * stopping the process, which is what a factory that spawned one wants; a factory that hands over a process
   * it did not spawn returns its own, since that process outlives every connection.
   */
  readonly cleanup?: () => void | Promise<void>;
}

/**
 * What a connection becomes: the process to serve.  It is called once the `$init` has been read, so the args
 * it carries are in hand — an actor definition is the shortcut for a factory that spawns one with them.
 */
export type SessionFactory<Meta = unknown> = (
  connection: Connection<Meta>,
  init: Init,
) => Served<Meta> | ServedProcess | Promise<Served<Meta> | ServedProcess>;

export interface ReactorOptions<Meta = unknown> {
  /** A connection was admitted and the process it is served on is up. */
  onSession?(session: Session<Meta>): void;
  /** Its connection closed, and the session is over. */
  onClosed?(session: Session<Meta>): void;
  /**
   * Every decoded frame, before the serve handles it.  Returning true swallows the frame, which is where a
   * subprocess's own output frames (`$fd`) are captured instead of passed on.
   */
  onIncomingFrame?(frame: Record<string, unknown>): boolean | void;
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

The loop it runs, in words: `accept()`; build the channel and do the `$proto` handshake (the spawner's job,
done here so a consumer never writes it); read the `$init` the far side opened with; call the factory with the
connection and that statement; serve the process it answers with; report it through `onSession`; when its
connection closes, run the session's cleanup (which stops the process unless the factory returned its own)
and report that through `onClosed`; accept again.
`stop()` closes the listener and ends every live session the same way, so a client learns the server is gone
when its connection closes.

The protocol step is one function of the loop: wrap the transport in `json1Channel`, send or await the
`$proto` frame, and hand the channel on.  A later version can take that as a parameter rather than writing it
in, which is why it stays in one place.

`onSession` and `onClosed` are the whole report: a connection was admitted and is being served, and a
connection is over.

A bare `ActorDefinition` is the shortcut for a factory that spawns it: the same call, with the definition
wrapped into a factory that spawns it with the `$init`'s args, name and parent, and reports no meta of its own.

## Listeners

The transport-specific half.  Two things a medium has, and the transport-agnostic reactor must not know,
live here: **admission**, and the arguments that arrive with the connection rather than with the actor.

```ts
export interface Upgrade<Raw = unknown> {
  /** The transport's own object: for a websocket, the request that asked to upgrade. */
  readonly raw: Raw;
  /** The URL, when the transport has one: its query is how arguments arrive with the connection. */
  readonly url?: URL;
}

export function webSocketListener<Meta = unknown>(options: {
  /** The HTTP(S) server whose upgrades become connections. */
  server: HttpServer;
  /** Which path upgrades; every upgrade when it is not given. */
  path?: string;
  /**
   * Admission and identity.  What it returns is the connection's meta; throwing refuses the
   * connection *before any actor exists*: a refused connection costs no actor.
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

A socket's `identify` receives the peer's credentials where the platform gives them (Linux `SO_PEERCRED`:
uid, gid and pid), which is what a listener with no token can admit on.  A platform that does not expose
passes `peer` as undefined rather than inventing one.

The socket file's lifetime belongs to its listener: the path is made and its mode set before the first
`accept()`; a path that exists and refuses a connection is a crash's leftover and is replaced; a path that is
not a socket is refused rather than removed; and `close()` unlinks the path only if it is still the inode this
listener bound, since a path replaced under it belongs to somebody else.

A fifo pair is a one-connection listener: a pair is one connection, so the medium gives exactly one client
per lifetime, and `accept()` resolves once and then the listener is done.  The open order that makes a pair
meet (the read end is opened only once somebody is writing, which is why `FifoUtf8NlineTransport` has
`beginConnect` and `connect` at all) is the listener's business rather than the consumer's, and `close()`
releases a wait that is still pending.  A second client means a second pair, and that is the medium's
property rather than the reactor's, so "one at a time" stops being something a consumer's own code has to
enforce.  The pair keeps shipping: this adds a listener and a client spawner for it, and takes nothing away.

What a listener does *not* do: frame anything (the transport's job), handshake `$proto` (the reactor's),
or know what an actor is.

## The client half, and the medium

A unix socket needs no new transport class.  `LineTransport` (`src/remote/stdio.ts`) already carries
newline-delimited JSON over a duplex stream, and a socket is one, so the client side is two functions and
a spawner:

```ts
/** Connect to a listener.  One call, and no open order: a socket is connected or it is not. */
export function connectUnixSocket(path: string, options?: { timeoutMs?: number }): Promise<LineTransport>;

/** The spawner for a socket, in the shape the websocket one has. */
export function socketClientSpawner<Args = unknown>(
  path: string | ((args: Args) => string),
  options?: { timeoutMs?: number },
): ClientSpawner<Args>;

/** The other half of a pair: connect to one that already exists, and do the handshake. */
export function fifoClientSpawner<Args = unknown>(
  paths: { read: string; write: string } | ((args: Args) => { read: string; write: string }),
): ClientSpawner<Args>;
```

Every medium the remote module supports, in one shape: a transport, a listener on the serving side, and a
spawner on the connecting side.  Only the medium's own facts differ, and only its listener knows them.

| medium | transport | listener (the serving side) | spawner (the connecting side) |
| --- | --- | --- | --- |
| unix socket | `LineTransport` over the socket | `unixSocketListener` | `socketClientSpawner` |
| websocket | `WebSocketTransport` | `webSocketListener` | `wsClientSpawner` |
| fifo pair | `FifoUtf8NlineTransport` | `fifoListener` (one connection per lifetime) | `fifoClientSpawner` (a pair that exists), `fifoArgvSpawner` (a pair it makes, for a child) |
| stdio | `LineTransport` over the stream pair | `subprocessListener` (it spawns the child; not built here) | `runRemoteRoot` (the payload side) |

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

**Admission before serving, and a registry reached by reference.**  What matters is kept, and nothing is spawned
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
the announcement, which is now the reactor's report, and the report is a *handle*, not a name: `serveRemoteActor`
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
hand, so moving from a pair to a socket is a new listener and almost nothing else.

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

- **`defineSubprocessActor(...)`** serves its actor over a spawned child, and that serve is the same
  one-connection reactor: the payload is handed a fifo pair in its argv, and the actor is served on it.  The
  medium below stays what it is — the two named pipes, `--fifo-in`/`--fifo-out`, the `$proto` handshake, one
  client per pair — and the parent's spawner keeps making the pair and spawning the child, its connect and
  handshake now the pair's client spawner.

  ```ts
  // the payload's side, where the actor is served: one connection over the pair in its argv
  serveRemoteActor(payloadDef, () => fifoArgvSpawner(own));
  // = reactor(oneConnection(() => fifoArgvSpawner(own)), payloadDef)

  // the parent's side, which holds the proxy: the pair is made here, and the child is told its paths
  remoteClient(payloadDef.name ?? "actor", commandSpawner([runner, scriptPath, marker]));
  ```

### The `$fd` frames, and where they belong

A payload run on a host the caller cannot reach has a first stage between the two: that stage's stdin and
stdout are the wire, and everything the payload prints comes back as `$fd` frames.  That is why the client side
wraps the transport in a filter today.  The reactor decodes every frame, so it is the one place that can lift
them out, and the hook is one option beside the two callbacks:

```ts
reactor(listener, payloadDef, {
  // true: captured here, so it does not reach the served actor
  onIncomingFrame: (frame) => captureOutput(frame),
});
```

The option is built and tested; what uses it is that path, not the pair, where the child's own stdout stays
free by construction and there is nothing to lift out.  The two other shapes considered, a reactor plugin and
a tap inside the listener that would decode every line twice, are not needed while this is the only hook of
its kind; the reactor never learns what `$fd` means.

What this asks of a `Listener`, beyond a socket: `accept()` may reject for reasons that are the medium's
own (a child that died, a connection that closed), a listener may have exactly one connection and then be done,
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
sessions visible in the tree).  It is deliberately *not* the primitive here: one of the shapes above is
a plain program with no actor context, and `serveRemoteActor` spawns rootlessly, so a listener and a
reactor work from anywhere.  The wrapper is drafted separately (`reactor-actor.md`); it is out of scope here.

## What it does not do

- **No authentication of its own.**  Admission is the listener's `identify`, which for a socket means the
  file mode and the peer credentials, and for a websocket what an admission step already does with a token.  The
  reactor never sees a token, a URL or a file.
- **No answering.**  The reactor reports a session and decides nothing about it.  A served actor that refuses
  something it was sent is making an application-level decision, and it acts on it by stopping.
- **No reconnection.**  A connection that closes is a session that ends; a client that wants to come back
  connects again, which is a new session.
- **No TLS and no network sockets.**  A unix socket is local by definition; `net` could get the same
  treatment later, with a different set of questions (a port to secure).
- **No framing of its own.**  Newline-delimited JSON via `json1Channel`, as the fifo and stdio transports are.
- **No promise that a process is served once.**  A factory may hand over a process it did not spawn and return
  its own cleanup for it, and one process may then be served on several connections, each a session of its own
  with its own root id.
- **No accept loop of its own at the transport layer.**  The reactor owns the loop; a listener only says
  what has arrived.

## Open

- **Serving one process on several connections.**  The shape is settled: the factory returns the process and
  says what ends it.  What a long-lived actor served directly still needs is its out-messages reaching every
  connection bound to it, and each connection numbers the root in its own table.  Worth verifying when it is
  first used that way, since that is what would let a long-lived actor be served with no per-connection
  session in front of it.
- **The wrapper** has open questions of its own, in `reactor-actor.md`.
