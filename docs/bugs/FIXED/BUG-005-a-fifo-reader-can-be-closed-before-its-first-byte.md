# BUG-005: A fifo reader can be closed before its first byte (bun)

**Found:** 2026-09-14, from the gate itself — about two runs in three, on this machine.

**Symptom:** `src/remote/transports/fifo.test.ts`, "beginConnect + connect full
round-trip", never settles and dies on the 5 s test timeout. It is green in a standalone
`bun` script running the same sequence (delivery in 9 ms), green when the file is
filtered to that test, and red in the file — even with the test moved to the top of it,
so it is not leakage from the other tests. It is not slowness either: the wait hangs.

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

**Fix:** neither half fixes the test on its own; both together do (eight consecutive
green runs of the file, 281 green in `scripts/test.sh`). The reader-plus-attached-writer
pair (`pvtWriter`, `attachWriter`) fell out with the second half: one transport with both
fds, which is what `fromFds` already was. The test is unchanged.

**Also, why it is not "just a test":** any fifo reader that starts before its peer writes
can lose its channel at startup, and the client end of a gateway inside an environment is
exactly that shape. Same family as [BUG-001](../BUG-001-child-process-hangs-on-early-exit-cpu-spin.md)
(bun + fifo open during startup).
