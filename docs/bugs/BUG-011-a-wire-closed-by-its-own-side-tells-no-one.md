# BUG-011: A wire closed by its own side tells no one

**Found:** 2026-10-18, from the `sip-connector` peer suite in the harness: "the daemon dying is
the peer ending, and it fails what was in flight" failed 3 of 8 runs on an unchanged tree.

**Symptom:** a spawned daemon is killed, and in a third of the runs the client never learns.
The op in flight is answered only by its own 5 s command timeout (`LISTCALLS: no reply in 5000
ms`), `wait()` on the far root never settles, and the peer reports itself connected to a process
that is gone. In the other runs the same case rejects in ~300 ms with "the daemon ended".

**Root cause:** `StringTransport.onClose` fired only from the reader's end-of-stream. A
transport — and so a channel — closed by the side that owns it told nobody. Every spawner built
on the pattern closes the channel when its child exits (`src/remote/spawners/fifo-command.ts:44`,
and the harness's own spawner): the client's `channel.onClose(() => wireGone())`
(`src/remote/client.ts:404`) never ran, so its handles stayed connected and nothing failed.

That made death detection a race: the peer's fds closing gives our reader an EOF (which does
notify), but our own `close()` destroys the reader first whenever it wins. Measured on the
harness's stand-in daemon: 3 of 8 kills lost the news; with the fix, 10 of 10 runs green.

**Fix:** `json1Channel` keeps its close readers, says closed exactly once, and says it from
either ending — the transport reporting the peer gone, or a `close()` here. The transport keeps
its narrower contract (it reports the *peer* going); "this channel is finished" is the channel's
to say. Commit `537a763`.

**Tests:** `src/remote/protocols/json1.test.ts` — closing the channel tells its close handler
once, and a peer reported gone twice says it once; both red in `e62d210` (`closes` 0 after a
close, 2 after two reports).
