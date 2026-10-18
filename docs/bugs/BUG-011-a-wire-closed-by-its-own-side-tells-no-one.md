# BUG-011: A wire closed by its own side tells no one

**Found:** 2026-10-18, from the `sip-connector` peer suite in the harness: "the daemon dying is
the peer ending, and it fails what was in flight" failed 3 of 8 runs on an unchanged tree.

**Symptom:** a spawned daemon is killed, and in a third of the runs the client never learns.
The op in flight is answered only by its own 5 s command timeout (`LISTCALLS: no reply in 5000
ms`), `wait()` on the far root never settles, and the peer reports itself connected to a process
that is gone. In the other runs the same case rejects in ~300 ms with "the daemon ended".

**Root cause:** neither built-in transport told its close handler that it had closed.  `onClose` fired
only from the reader's end-of-stream, so a wire ended by the side that holds it was silent: every
spawner closes the channel or the transport when its child exits (`src/remote/spawners/fifo-command.ts:44`,
and the harness's own spawner closes the transport), and the client's `channel.onClose(() => wireGone())`
(`src/remote/client.ts:404`) never ran.  Its handles stayed connected, its in-flight call was left to
its own command timeout, and nothing failed.

That made death detection a race: the peer's fds closing gives our reader an EOF (which does notify),
but our own close destroys the reader first whenever it wins.  First fix attempt (`537a763`) put the
notifier in `json1Channel`, which covers a caller that closes the *channel* — the harness's spawner
closes the *transport*, so it kept failing: 3 of 5 parallel gate runs, each failing at the op's 20 s
command timeout.

**Fix:** each transport says closed once, from either ending — the reader's end, or a close here
(`ae2529f`).  The channel delegates again, as it did before; the ending is one fact and it belongs
where the wire stops carrying.

**Tests:** `src/remote/transports/fifo.test.ts` — this side's close says closed, and a peer end
followed by a close here is still one; `src/remote/stdio.test.ts` — the same for `LineTransport`.
Red in `ddd7be7`.
