# posipaki: a unix socket transport

> **Status**: Draft proposal. No code written yet.

## Summary

A unix socket is the missing transport for "a program on the same host that a person
runs": the websocket transport is for a network and needs a port to secure; the worker
transport is the same process; the fifo pair needs an open order that is a handshake,
carries one client at a time, and can be poisoned by a client that dies.

No new transport class is needed. `LineTransport` already carries newline-delimited JSON
over a duplex stream, and a socket is one, so what this adds is the socket's *lifetime*
and the seam's two halves over it:

```ts
import { listenUnixSocket, connectUnixSocket, socketServerSpawner, socketClientSpawner }
  from "posipaki/remote/node";

// the server: it owns the listener, and serves one actor per accepted connection
const server = await listenUnixSocket({ path: "/run/dopje/console.sock" });
for (;;) {
  const transport = await server.accept();
  serveRemoteActor(sessionDef, socketServerSpawner(transport)); // not awaited: each runs its own life
}
await server.close(); // stops listening, ends the connections, removes the path

// the client: one call, no open order, a proxy of whatever the server served
const Proxy = remoteClient("console", socketClientSpawner("/run/dopje/console.sock"));
```

## Motivation

The seam is transport-agnostic by design, and the custom-transport doc already names the
unix socket as the example of a transport somebody would write ("the same actor can run
over Kafka, a Unix socket, WebRTC, or an in-memory pipe once you write one transport and a
spawner"). Writing it once here is cheaper than every consumer writing it, and it is the
one medium whose whole access control is a file mode.

The fifo pair, which is what this replaces in the case that asks for it, costs four
things that a socket does not:

- **An open order that is a handshake.**  A read stream on a fifo with no writer is handed
  an immediate end-of-stream by some runtimes, so `FifoUtf8NlineTransport` has
  `beginConnect` and `connect`, and the two ends must open in the right order or deadlock.
  A socket has no such state: it is connected or it is not.
- **One client at a time.**  A pair is one wire, so two clients' bytes interleave, and
  serving several means opening a pair per client.
- **A poisoned path.**  A file that is not a fifo where the wire belongs breaks every
  later attach (this happened; see the harness's BUG-054), and a client that dies can
  leave a frame for the next one (BUG-056).
- **A lifetime nobody owns.**  The fifos outlive the process that made them, so a stale
  pair is a thing to be recognised and refused rather than a thing that is cleaned up.

## The API

All of it node/bun-only, exported from `src/remote/node.js` beside the fifo pieces, in
`src/remote/socket.ts`.

```ts
export interface UnixSocketOptions {
  /** The socket file.  Made when the listener starts, removed when it stops. */
  path: string;
  /**
   * The mode of the socket file, set before anybody can connect.  Default 0o600, since the
   * path is the whole access control for a local socket.
   */
  mode?: number;
  /**
   * Whether a path that exists and refuses a connection may be replaced.  A socket nobody
   * listens on is a leftover from a crash, and replacing it is the point; a path that is
   * not a socket at all is refused, never replaced, because a wrong file where the wire
   * goes is a mistake to be told about.
   */
  replaceStale?: boolean;   // default true
  /** Listen backlog, passed through to the runtime.  Default: the runtime's. */
  backlog?: number;
}

export interface UnixSocketServer {
  readonly path: string;
  /**
   * The next client, as a transport ready for a spawner.  Call it as often as you serve:
   * nothing here counts clients.  Rejects once the listener is closed.
   */
  accept(): Promise<LineTransport>;
  /**
   * Stop listening, end the live connections (a client learns its console is gone by its
   * read end closing, which is what the seam already turns into `CHANNEL_LOST`), and
   * remove the path if it is still the socket this server bound.
   */
  close(): Promise<void>;
}

export function listenUnixSocket(options: UnixSocketOptions): Promise<UnixSocketServer>;

/** Connect to a listener.  One call: there is no order to get right. */
export function connectUnixSocket(
  path: string,
  options?: { timeoutMs?: number },
): Promise<LineTransport>;

/** The seam's two halves over a socket, exactly as the websocket ones are. */
export function socketServerSpawner(transport: LineTransport): Spawner;
export function socketClientSpawner<Args = unknown>(
  path: string | ((args: Args) => string),
  options?: { timeoutMs?: number },
): ClientSpawner<Args>;
```

Notes on the pieces:

- **The transport is `LineTransport`.**  A socket is a duplex stream, so `new LineTransport({
  read: socket, write: socket })` is the whole implementation, and the framing, the
  single-handler rule, the idempotent close and the unreadable-frame handling are the ones
  the stdio wire already has.  Nothing new is shipped for the medium itself.
- **The spawners match the websocket pair.**  `socketServerSpawner` sends `$proto` and
  returns the channel (`wsServerSpawner` in full).  `socketClientSpawner` connects, sets
  the `$proto` waiter *before* the connect resolves, validates the version and returns the
  channel — the same shape, and the same reason for the ordering: a fast server's first
  frame must not be dropped.
- **`connectUnixSocket` is one call** because a socket has no open order; the fifo's two
  entry points exist for a state a socket does not have.
- **Failures say what they are.**  A missing path reports that nobody is listening at that
  path; a path that is not a socket is refused as such; a connect that takes too long is
  timed out rather than left hanging.  A peer that goes away is `onClose`, as everywhere.
- **The path's lifetime is the listener's.**  `listenUnixSocket` binds and sets the mode
  before accepting; `close()` unlinks it, and only if it is still the inode this server
  bound (a path that was replaced under us is somebody else's).  Nothing is left for a
  later start to trip over, which is the fifo's fourth cost above.

**One shape across the media.**  A medium in this seam is a transport, a server spawner and a client
spawner, and a socket is no exception: `socketServerSpawner` is `wsServerSpawner` with a socket under it,
`socketClientSpawner` is `wsClientSpawner` with a path instead of a URL, and the accept a websocket gets
from an HTTP server's upgrade a socket gets from `listenUnixSocket`.  What differs is where the listener
comes from and what the address is; what a consumer writes — transport, spawner, `serveRemoteActor` or
`remoteClient` — does not.

## What it does not do

- **No authentication.**  The file mode is the access control, and that is the point of a
  local socket.  No tokens, no handshakes of our own beyond `$proto`.
- **No TLS, no network sockets.**  A unix socket is local by definition; `net` could be
  given the same treatment later, with a different set of questions (a port to secure).
- **No reconnection.**  A wire that goes is a proxy that ends with `CHANNEL_LOST`, exactly
  as with every other transport; reconnecting is the consumer's decision.
- **No accept loop of its own.**  `accept()` is called by whoever serves; the listener does
  not know what is on the other side of a connection.  (This is `wsServerSpawner`'s split
  too: the HTTP server does the upgrade.)
- **No framing of its own.**  Newline-delimited JSON via `json1Channel`, as the fifo and
  stdio wires already are.
- **No serving of a running process.**  What is served per connection is still an actor the
  server spawns; see the open question below.

## Fit: the console in the harness

The case that asks for this is the operator console (`email-agent`, `docs/console.md`): a
console actor in the harness, and a terminal program a person runs on the same host.

Today the roles are the other way round: the *program* serves the terminal
(`serveRemoteActor(TerminalActor, servePair(paths))`) and the console connects to it and
forks a `remoteClient` proxy per attach.  With a socket, the harness binds and accepts, and
the program is the client.

- **What changes here.**  The console's wire loop stops connecting and starts accepting:
  per accepted connection it serves a per-connection session actor with
  `socketServerSpawner`.  That session is spawned at accept time, so
  `serveRemoteActor`'s rule (spawn what you serve, stop it when the wire drops) is exactly
  right for it.  The program forks a proxy of that session and drives its terminal from
  what the proxy emits.
- **What does not change.**  The console's vocabulary (`CONSOLE_LINE`, `CONSOLE_COMPLETE`,
  the five it sends back), its presence list, its receipts (`sent` with a terminal
  attached, `failed` with none), the command table, and the layer split.
- **What it buys.**  Several clients at once, which the console already supports (it holds
  a list); a client that dies leaving nothing for the next one; no open order to get wrong;
  and a terminal program that is a plain client of a path.
- **A run's own terminal** stays what it is: the same program run as a child, connecting to
  the same path, which is what "the console cannot tell the two apart" already means.
- **The switch changes with it.**  `--allow-repl-fifo` and `--repl-fifo-dir` become one
  path (`--console-socket`, or the run directory's default), and the deployed unit's
  `ExecStart` changes with them.

## Two other servers of this shape

Both are a persistent process that accepts connections, and they solve the same problem differently.

- **prsquare-sign** (a node HTTP server in a unit of its own): the HTTP server owns the upgrade, and per
  `/ws` connection it does `serveRemoteActor(JournalSession, wsServerSpawner(ws))` — the session is
  spawned at accept, which is the seam's factory rule doing the work.  What is persistent there is not an
  actor at all: it is the journal store on disk, which the session reads and writes.
- **the voice server** (`email-agent`, `vendored/voice-server`): the door authenticates at the upgrade,
  before any actor exists, and then serves one `makeConnection(...)` actor per socket, built per
  connection so that the resolved client name arrives through a closure rather than through the client's
  own words.  What is persistent *is* an actor, a singleton router reached with `router.send(...)`, and
  the connection identifies its conversation by a reference (`conn: this.self`) rather than by a name,
  because two connections can carry the same client name.  The conversation's id is minted once, by the
  connection.

The console is the third, and it is the voice server's shape with one difference the socket makes room
for: the console's own loop accepts, so each session is handed the console's handle at spawn instead of
looking it up.  What all three share is what the API above is shaped for: a listener, `accept()`, one
served actor per connection (spawned at accept and stopped by the seam when its wire goes —
`serveRemoteActor` does that, `server.ts:174`), and a conversation identified by a process reference
rather than by a name the client chose.

## Open

- **`accept()` hands back a transport, not a channel.**  The caller then picks the protocol
  (`json1Channel`), as the websocket side does.  The alternative — returning a `Channel` —
  would bake json1 into the listener.
- **The mode's default, and whether posipaki sets it.**  0o600 in the proposal: a local
  socket whose path is its access control should not be world-writable by default.  The
  caller can still pass what it wants.
- **Replacing a stale path by default.**  It makes a crashed run recoverable in one start;
  it also means a listener that recognises the difference between "a socket nobody listens
  on" (`ECONNREFUSED`) and "something else is here" has to be careful.  The refusal for a
  non-socket path is not optional.
- **Whether the pair stays.**  Once a socket exists there is little the pair does better,
  and every consumer that keeps both keeps both sets of failure modes.  Deprecating it is a
  separate decision.
- **Serving a *running* process, which this does not do.**  A console is already running
  when a client arrives, so the harness serves a per-connection session instead of the
  console itself.  Serving the running console would remove that actor, and it needs a
  primitive posipaki does not have (`serveRemoteActor` spawns what it serves).  Bigger than
  this transport, and worth its own proposal; the socket is worth having either way.
