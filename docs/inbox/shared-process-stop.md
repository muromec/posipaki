# A far-side stop ends a process the factory said outlives the connection

**Parked:** 2026-11-20, from prsquare-sign serving one document authority to every
connection instead of one actor per client.

**Implemented:** 2026-11-21 — a stop for the connection's root settles the session
(`pvtGone`) instead of stopping the process the frame names, so the teardown runs
`Served.cleanup` and a handed-over process outlives it.  `src/remote/server.ts:355-370`,
`src/remote/channel.ts:306-310`, and the case in `src/remote/reactor.test.ts`.

## What

`Served.cleanup` says what a handed-over process is: run when the connection is
over, and — in its own words — "a factory that hands over a process it did not
spawn returns its own, since that process outlives every connection"
(`src/remote/server.ts:64`).

It does not outlive a *stop*.  A STOP frame from the far side goes through the
control branch and straight to the process (`src/remote/server.ts:355`):

```ts
if (isStop(frame) || isPause(frame) || isResume(frame)) {
  if (isProcess(mine)) {
    if (isStop(frame)) void mine.stop({ from: sender });
```

`cleanup` is not consulted on that path, so the connection that happened to be
holding the root can end the shared process — and with it every other session
bound to it.

## Why it matters

Measured on prsquare-sign, two clients on one durable authority, both served the
same process with `cleanup: async () => {}`:

- `reactor.live` is 2 while both are connected;
- the first client stops cleanly (`proc.stop()` on its side sends a STOP for the
  far root);
- `live` goes to 0, and the second client's next request never reaches the log.

So a shared authority cannot be served today.  The workaround is the wrapper the
attempt was meant to remove: one connection-scoped actor per client, mirroring the
one shared process.

## Fix

In the control branch, a stop (pause, resume) that names the connection's root is
a request to end *this session*, not to stop a process that may be every session's:

```ts
if (isProcess(mine)) {
  if (to === table.rootId()) {
    if (isStop(frame)) void end();
    else if (isPause(frame)) mine.pause();
    else mine.resume();
  } else if (isStop(frame)) void mine.stop({ from: sender });
```

`end()` is `served.cleanup ?? (() => proc.stop())` and is idempotent, so:

- a process the factory spawned has no cleanup and stops exactly as it does now;
- a handed-over process runs its cleanup (in the shared case, nothing) and only
  the session ends.

Any other id is a process the far side spawned through this connection, and a
stop for one of those still stops it.

## Rejected alternative

Giving the authority `onStopRequested` and refusing every stop.  It works, but
the hook is not told who asked (`callHook(assembly.onStopRequested, …,
actorCtx)`), so a browser leaving and an operator closing the document are the
same event; closing then needs a second door (`forceStop` or a message of our
own), and every consumer of a shared process would invent one.

## Acceptance

- a test: one factory hands the same process to two connections with a no-op
  cleanup; stopping one client leaves the other able to send, the process alive,
  and `live` at 1;
- a process the factory spawned still ends when its connection's root is
  stopped — the behaviour every current consumer has.
