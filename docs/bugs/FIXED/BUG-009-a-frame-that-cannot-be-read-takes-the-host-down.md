# BUG-009: A frame that cannot be read takes the host process down

**Found:** 2026-09-28, against the voice service (posipaki 0.40.0, `json1` over a
WebSocket): one line that is not JSON, sent by an authenticated client, and the whole
process is gone — every other connection in it with it.

**Symptom:** the service exits on a `SyntaxError` from `JSON.parse`, with nothing
logged about the frame that caused it. The journal shows the neighbouring failure
being handled in the same second — a valid frame that is not a `$init` is caught and
logged as `expected $init` — while the unreadable one is not caught by anything. Under
systemd (`Restart=on-failure`, `StartLimitBurst=5`) a client that retries five times
inside ten seconds leaves the unit `failed` and it stays down until `reset-failed`.

**Root cause:** `json1Channel` decoded each line inside the transport's own message
callback:

```ts
transport.onMessage((str) => handler(decode(str)));
```

The throw is therefore raised *asynchronously with respect to `serveRemoteActor`* — it
lands in the socket library's `emit('message')`, not in the promise the listener
catches. A frame-level failure had no owner, so it became an uncaught exception, and
what an uncaught exception ends is the process. The receiving side's `catch` was not
inadequate; it was on the other side of that boundary.

`JSON.parse` accepting any JSON also meant a frame that *parsed* could be just as
fatal: `42`, `"x"`, `[1]` and `null` all reach the frame guards, and `"$init" in 42`
throws a `TypeError` for the same reason.

**Fix:** a frame that cannot be read is now *a frame about the wire* rather than an
exception (`channel.ts`):

- `json1Channel` reads through `readFrame`, which never throws: a line that is not JSON,
  or that is JSON but not an object, comes back as `{"$bad": {"reason", "length",
  "prefix"}}`. The prefix is capped (`BAD_PREFIX_LIMIT`) — a line that failed to parse
  is the one line nobody vouched for, and it is not carried whole into a log,
  a transcript or a context window.
- **Server** (`serveRemoteActor`): `$bad` is answered with `{"$error": "<reason>"}` and
  then that connection ends — the actor spawned for it goes with it. Nothing is raised
  into the host, and other connections are untouched. A `$bad` arriving before `$init`
  is a failed start like any other: the far side is told, and the caller that opened the
  connection has it as a rejection.
- **Client** (`remoteClient`): a `$bad` or `$error` from the far side is the wire going,
  and takes the path a dropped wire already took — in-flight calls fail, handles
  disconnect, the proxy ends with `CHANNEL_LOST`. A frame that *reads* and is not
  understood is not this, and is still ignored rather than answered with a broken
  connection.
- `$error` moved up out of `stdio.ts` into the shared vocabulary: one word for a wire
  that cannot be spoken over, whether the failure was at the start of a session or in
  the middle of one.

**Tests:** `protocols/json1.test.ts` — a malformed line, and a line that is JSON but not
an object, arrive as `$bad` with the transport callback not throwing. `server.test.ts` —
a `$bad` frame is answered with `$error` and ends that connection (the actor stops, the
serving call returns), a first frame that cannot be read is refused with a reason, and a
second connection served by the same process is unaffected. `client.test.ts` — a far
side's `$bad` ends the proxy with `CHANNEL_LOST`, while a readable frame it does not
understand does not. `ws.integration.test.ts` — on a real socket: a peer sends a line
that is not a frame, is told why, and the next connection is served as if nothing had
happened.

**Not the fix:** a process-level `uncaughtException` handler. A library must not install
one, and a service that continues after an unknown fault is a service lying about what
still works — the throw belonged to the connection, so it is the connection that ends.

**Fixed in:** 0.41.0, `5b23160`. The voice service on the box with the audio was rebuilt
with it the same evening and checked against the live socket in both shapes: a line that is
not JSON before the handshake (answered `expected $init: …`, the connection ended) and one
after it (answered `$error: …`, the connection ended). In both the process kept its
`NRestarts=0` and the next connection was greeted, and its journal carries the two markers
worth grepping for — `a frame from the far side could not be read: <reason>` for the second
shape, and the listener's `could not be served: Error: serveRemoteActor: expected $init
(<reason>)` for the first. That deployment's bundles were built from this tree rather than
from the registry copy of the package (0.41.0 is not published yet), which is why the
release line here names the commit.
