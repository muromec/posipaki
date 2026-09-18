# BUG-003: A spawner that fails leaves the spawn unsettled (and crashes the end-of-life hooks)

**Found:** 2026-09-13, from email-agent, where a tool-pool environment that cannot be
booted — `sudo` without NOPASSWD, a missing binary, a worker that dies during its
handshake — is supposed to answer its tool calls with the reason; instead the calling
process died.

**Symptom:** with `remoteClient(name, spawner)`, `setup()` awaits the spawner. When it
rejects, the runtime generator throws before its first `yield`, so `self.state` is never
assigned. Three things then go wrong at once:

- `pvtWatchExit`'s finally still runs `afterExit()` → `afterEnd()`, which reads
  `this.state.private` — the TypeError *replaces* the original error;
- the initial `next()` in `start()` had no rejection handler, so that TypeError
  escapes as an unhandled rejection and takes the calling process with it;
- `ready()` is never settled, so `spawn()` and `proc.ready()` hang forever.

Reproduced with `remoteClient("counter", () => Promise.reject(new Error("no environment
for you")))`. A remote that cannot be reached is a normal event, not a fatal one: the
caller has to get its own error back.

**Root cause:** the start path had no failure path of its own. `setup()` throwing was
treated as "the generator ended", and the end was handled as if the actor had lived —
with `onError` never seeing the error either.

**Fix:** `pvtStartFailed()` — a rejection of the initial `next()` marks the process dead,
rejects `ready()` with the error (which is what makes `spawn()` reject), and settles
`wait()`. End-of-life hooks (`afterEnd`) are skipped for an actor that never got a state:
they are typed as having one, and an actor that never started has nothing to end.
Cleaning up work that `setup()` did before it threw belongs inside `setup()`.

**Tests:** `src/actor-setup.test.ts` — *"fails the spawn, without running the end-of-life
hooks"*.
