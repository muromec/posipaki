# BUG-004: A message sent before the process is ready is swallowed

**Found:** 2026-09-12, from email-agent — a flaky test that failed in about 1 run in
10-30, never in isolation, with the actor idle, `usage: null`, `refSeq: 0`, as if no
message had ever arrived.

**Symptom:** `spawn()` (and `spawnAsync()`, and `fork()`) handed back the process handle
as soon as the generator started, which is *before* the initial state has been delivered.
A message sent in that window never reached a handler: the tick `send()` schedules
resumed the generator at its **initial yield**, so the message became the value of that
yield — which the actor's own `yield*` ignores — and was dropped. Worse, `start()`'s own
advance was then fed into the dispatch loop in the message's place, so the actor
processed a framework no-op instead of the message. Silent, order-dependent, and
invisible when the sender happens to be slower than the setup.

**Root cause:** the dispatch loop and `start()` were both resuming the same generator,
and nothing stopped a tick from racing `start()` to the initial yield.

**Fix:** the process now tracks whether the dispatch loop is live (`pvtDispatchLive`).
Ticks that fire before the initial state is delivered leave the message in the buffer
instead of feeding it to the generator; `start()` advances past the initial yield first
and then schedules a tick if anything queued up. `spawn()` also awaits `ready()` by
default (`awaitReady: false` for the raw handle, and for actors whose setup waits for the
outside world — a `remoteClient` proxy waits for the server's first `$state` frame, so
awaiting would deadlock).

**Tests:** `src/actor-setup.test.ts` — *"a message sent while setup is still running >
is handled, not swallowed"*.

**Also, found in the same session while fixing it:** an actor that is *idle* (parked at
its dispatch yield) never noticed `this.exit()` called from outside the loop — the loop
only re-reads `done` when something resumes it, so the actor sat there forever and
`wait()` never settled. It looked fine in the existing tests only because the exit
usually landed while the actor was still starting up, where the loop's entry check
catches it. `exit()` now wakes the loop (`ctx.wake()` → an internal no-op message that
no hook or handler ever sees). Test: `src/lifecycle-hooks.test.ts` — *"exit() from
outside the dispatch loop > ends an idle actor"*.
