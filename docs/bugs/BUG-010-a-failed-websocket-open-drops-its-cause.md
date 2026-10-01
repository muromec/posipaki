# BUG-010: A failed websocket open drops its cause

**Found:** 2026-10-01, from the harness side (posipaki 0.40.0 there, 0.41.0 here): the
voice transports' children logged `no voice path: websocket failed to open: [object
ErrorEvent]` 24 times in forty minutes, and nothing in those lines named a cause, while the
events that could explain them (two service restarts, three harness restarts) were far
fewer.

**Symptom:** a websocket that cannot be opened is reported as

    websocket failed to open: [object ErrorEvent]

The event the socket library hands `onerror` carries everything: its `type` (`error`), its
`message`, and, for the failures that matter, the underlying error (`connect ECONNREFUSED
127.0.0.1:1`). All of it is lost at the point where it is reported.

**Root cause:** `openWebSocket` (`src/remote/spawners/ws-client.ts`) stringified the event:

```ts
ws.onerror = (err) => reject(new Error(`websocket failed to open: ${String(err)}`));
```

A WHATWG `WebSocket` reports an open failure as an `ErrorEvent`, and `String(event)` is
`[object ErrorEvent]`, because the class does not define `toString`. So the only instrument
a caller has for "why did the wire not come up" was that string, and the string was a
placeholder.

**Fix:** the failure describes itself again. `describeSocketError` reads the event's own
fields, `type`, `message` and `error` (unwrapped when it is an `Error`), and joins the ones
that are non-empty; anything that is not an object, or an object with none of them, still
falls back to `String(err)`, so no case becomes less informative than it was. The line now
reads

    websocket failed to open: error: connect ECONNREFUSED 127.0.0.1:1

**Tests:** `src/remote/spawners/ws.test.ts`, "names what a failed open was, rather than the
event that carried it": a fake socket hands `onerror` an event with an underlying error,
and the rejection has to name it. Red before the fix, where it read `[object Object]`.
