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
