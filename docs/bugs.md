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
