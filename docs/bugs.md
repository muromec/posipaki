# Bugs

## Child process hangs on early exit (CPU spin)

**Observed:** 2026-08-07

When `runChild()` fails early (e.g. missing `--fifo` flag), the child
process prints an error and calls `process.exit(1)`. Under `bun run`,
the process sometimes hangs instead of exiting:

- The process does not terminate — it must be killed manually
- CPU usage is 30-50% while "waiting" — the event loop appears to spin
- The parent process (command tool harness) also waits indefinitely
- The `timeout` command reports a timeout, but the process was killed
  manually, not by timeout

**Root cause:** Not yet identified. Suspected bun event loop issue with
async I/O (fifo open) during early startup failure.

**Workaround:** Ensure `--fifo` is always passed when spawning a remote
actor child process.

## An observing `onError` absorbs lifecycle hook errors

**Observed:** 2026-09-12 (found from email-agent; a reflector whose reflection
pass died before reporting stayed up, silently, forever)

With an `onError` handler registered, a throw from a *lifecycle* hook
(`onChildExit`, `beforeEnd`, `afterEnd`, `onStopRequested`, `onStart`,
`onOrphan`) was absorbed by `callHook`: `onError` ran (a logger logged it) and
the actor carried on. A lifecycle hook is the actor's own control flow, so
"carrying on" leaves the state machine half-applied: the actor stays up with
nothing left to do, its `wait()` never settles, and its parent never receives
the EXIT — it looks alive but is finished. The bundled `debugLogger` plugin
registers `onError` (to log), so merely turning on logging was enough to change
failure semantics.

Reproduced with `defineActor`: parent + `onChildExit` that throws + an `onError`
handler → `wait()` never settles and no EXIT is emitted. Without the handler, the
same actor rejects `wait()` and emits EXIT (the correct behaviour).

**Root cause:** `callHook` treated any `onError` as "handled". There was no way
for an error handler to say "I only observed this".

**Fix:** `propagateError()` / `PROPAGATE_SENTINEL` (mirroring
`stopPropagation()`).  `callHook` now asks the error handler what it decided:
returning the sentinel means "I only observed this — let it propagate", and the
error keeps going.

Lifecycle hook call sites pass an internal handler that calls `onError` (so a
logger still logs) and then returns the sentinel, so a broken lifecycle hook is
always fatal.  Message hooks and handlers are not forced either way: they are
called with `onError` itself, and its *return value* decides — nothing (the
default, and what the bundled logger returns) absorbs the error and the actor
carries on; `propagateError()` declines to handle it and the actor goes down like
any other fatal error.  With `chainHook` the actor's own handler has the last
word, so its `propagateError()` is honoured even under a plugin that returned
nothing.

## A spawner that fails leaves the spawn unsettled (and crashes the end-of-life hooks)

**Observed:** 2026-09-13 (found from email-agent, where a tool-pool environment
that cannot be booted — `sudo` without NOPASSWD, a missing binary, a worker that
dies during its handshake — is supposed to answer its tool calls with the
reason; instead the calling process died)

With `remoteClient(name, spawner)`, `setup()` awaits the spawner.  When it
rejects, the runtime generator throws before its first `yield`, so `self.state`
is never assigned.  Three things then go wrong at once:

- `pvtWatchExit`'s finally still runs `afterExit()` → `afterEnd()`, which reads
  `this.state.private` — the TypeError *replaces* the original error;
- the initial `next()` in `start()` had no rejection handler, so that TypeError
  escapes as an unhandled rejection and takes the calling process with it;
- `ready()` is never settled, so `spawn()` and `proc.ready()` hang forever.

Reproduced with `remoteClient("counter", () => Promise.reject(new Error("no
environment for you")))`.  A remote that cannot be reached is a normal event,
not a fatal one: the caller has to get its own error back.

**Root cause:** the start path had no failure path of its own.  `setup()`
throwing was treated as "the generator ended", and the end was handled as if the
actor had lived — with `onError` never seeing the error either.

**Fix:** `pvtStartFailed()` — a rejection of the initial `next()` marks the
process dead, rejects `ready()` with the error (which is what makes `spawn()`
reject), and settles `wait()`.  End-of-life hooks (`afterEnd`) are skipped for
an actor that never got a state: they are typed as having one, and an actor that
never started has nothing to end.  Cleaning up work that `setup()` did before it
threw belongs inside `setup()`.

## A message sent before the process is ready is swallowed

**Observed:** 2026-09-12 (found from email-agent; a flaky test that failed in
about 1 run in 10-30, never in isolation, with the actor idle, `usage: null`,
`refSeq: 0` — as if no message had ever arrived)

`spawn()` (and `spawnAsync()`, and `fork()`) handed back the process handle as
soon as the generator started, which is *before* the initial state has been
delivered. A message sent in that window never reached a handler: the tick
`send()` schedules resumed the generator at its **initial yield**, so the
message became the value of that yield — which the actor's own `yield*` ignores —
and was dropped. Worse, `start()`'s own advance was then fed into the dispatch
loop in the message's place, so the actor processed a framework no-op instead of
the message. Silent, order-dependent, and invisible when the sender happens to
be slower than the setup.

**Root cause:** the dispatch loop and `start()` were both resuming the same
generator, and nothing stopped a tick from racing `start()` to the initial
yield.

**Fix:** the process now tracks whether the dispatch loop is live
(`pvtDispatchLive`). Ticks that fire before the initial state is delivered leave
the message in the buffer instead of feeding it to the generator; `start()`
advances past the initial yield first and then schedules a tick if anything
queued up. `spawn()` also awaits `ready()` by default (`awaitReady: false` for
the raw handle, and for actors whose setup waits for the outside world — a
`remoteClient` proxy waits for the server's first `$state` frame, so awaiting
would deadlock).

Regression test: `src/actor-setup.test.ts` — *"a message sent while setup is
still running > is handled, not swallowed"*.

**Same session, found while fixing it:** an actor that is *idle* (parked at its
dispatch yield) never noticed `this.exit()` called from outside the loop — the
loop only re-reads `done` when something resumes it, so the actor sat there
forever and `wait()` never settled. It looked fine in the existing tests only
because the exit usually landed while the actor was still starting up, where the
loop's entry check catches it. `exit()` now wakes the loop
(`ctx.wake()` → an internal no-op message that no hook or handler ever sees).
Regression test: `src/lifecycle-hooks.test.ts` — *"exit() from outside the
dispatch loop > ends an idle actor"*.

## A fifo reader can be closed before its first byte (bun)

**Observed:** 2026-09-14, from the gate itself (about two runs in three, on this
machine)

`src/remote/transports/fifo.test.ts`, "beginConnect + connect full round-trip", never
settles and dies on the 5 s test timeout. It is green in a standalone `bun` script
running the same sequence (delivery in 9 ms), green when the file is filtered to that
test, and red in the file — even with the test moved to the top of it, so it is not
leakage from the other tests. It is not slowness either: the wait hangs.

**Symptom, instrumented:** both sides come up, `server.send("server-to-client\n")`
resolves, and the client transport is already closed with `lastError === null`. The read
side's events are `rl close` → `rs end` → `rs close`, and no `data` event ever fires:
end-of-stream, not an error, on a channel that never carried a byte.

**Root cause:** two things, both in `FifoUtf8NlineTransport`:

- The streams were built on the *numeric fd* of a `FileHandle`
  (`createReadStream("", { fd: handle.fd, autoClose: false })`). Logging the fds of a
  failing run shows both sides' **writers reporting the same number** (38 — the readers
  had 36 and 37): what a handle reports and what its descriptor is are not the same thing
  to bun, and a stream attached to the wrong number reads another channel, or none.
  Building the streams from the handle itself (`handle.createReadStream()`,
  `handle.createWriteStream()`) removes that class of mistake.
- The reader's stream was constructed while **no writer existed yet** on the fifo it
  reads: `beginConnect` / `connect` built the reader — and its stream — as soon as the
  read fd was open, and only then opened the other direction. Under bun, a read on a
  fifo with no writer is handed to the stream as end-of-stream rather than "nothing yet",
  and the transport, correctly, treats `close` as the peer going away.

Neither half fixes the test on its own; both together do (eight consecutive green runs of
the file, 281 green in `scripts/test.sh`). The reader-plus-attached-writer pair
(`pvtWriter`, `attachWriter`) fell out with the second half: one transport with both fds,
which is what `fromFds` already was. The test is unchanged.

**Why it is not "just a test":** any fifo reader that starts before its peer writes can
lose its channel at startup, and the client end of a gateway inside an environment is
exactly that shape. Same family as the "child process hangs on early exit" entry above
(bun + fifo open during startup).

## A hook's `this:` annotation erases the methods surface

**Observed:** 2026-09-19 (from email-agent: `this.slot.poolSize` shipped in a method body
— `slot` was a method, so the call returned `any`; eight of its ten actors were in that
state)

A `this:` parameter on a hook is part of that function's signature, so checking a config
literal instantiates `ActorContext` while `Methods` is still being inferred.  That
instantiation is built from the constraint (`{ [key: string]: Function }`) and reused
afterwards, so every `this.<method>()` in the config returns `any` and the methods' own
`ThisType` sees the same thing — with no diagnostic.  It is the *position* that decides:
a hook written above `methods` which mentions `this` is enough, and no method body has to
mention `this` at all.

Measured on email-agent's ten `defineActor` sites: eight poisoned (main actor, connector,
reflector, repl, matrix, schedule, tool-task, actor-server); the two clean ones (chat,
task-server) only because their `setup` never mentions `this` — adding
`afterStart() { void this.name; }` above chat's `methods` poisons it, and the same hook
below them does not.

**Root cause:** the config's contextual type mentions the type parameters being inferred
from it.  A `ThisType` marker is applied after inference and is safe; a per-hook annotation
is part of the signature and is not.

**Fix:** `ActorConfig` carries one `ThisType`; the hooks carry no annotation except
`beforeStart` and `setup`, which keep one with `MethodOptions` in place of the inferred
methods — both need `never` for the state, and a `setup` that mentioned `InternalState`
would make the state inference depend on itself.  A plugin's overlay is a
`Partial<>`, which does not carry the marker, so `mergeConfigs` restores it through
`ActorContextOf<C>`.

**Guard:** `src/actor-types.test.ts` — it expects two errors that only exist on a typed
surface, and asserts that a method's return type is not `any`.
