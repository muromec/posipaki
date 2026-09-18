# Known Bugs

> One file per bug.  Active bugs live in this directory, fixed ones in `FIXED/`.
> The table below is the index; keep it current when a bug is filed or fixed.

**Next free id: BUG-007.**

## Index

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| BUG-001 | [Child process hangs on early exit (CPU spin)](BUG-001-child-process-hangs-on-early-exit-cpu-spin.md) | 🟡 MEDIUM | **open** |
| BUG-002 | [An observing `onError` absorbs lifecycle hook errors](FIXED/BUG-002-an-observing-onerror-absorbs-lifecycle-hook-errors.md) | — | fixed 0.31.0, `7547bd4` |
| BUG-003 | [A spawner that fails leaves the spawn unsettled](FIXED/BUG-003-a-spawner-that-fails-leaves-the-spawn-unsettled.md) | — | fixed 0.32.1, `51404e8` |
| BUG-004 | [A message sent before the process is ready is swallowed](FIXED/BUG-004-a-message-sent-before-the-process-is-ready-is-swallowed.md) | — | fixed 0.32.0, `3cb5bd5` |
| BUG-005 | [A fifo reader can be closed before its first byte](FIXED/BUG-005-a-fifo-reader-can-be-closed-before-its-first-byte.md) | — | fixed 0.33.1, `f5ac3e9` |
| BUG-006 | [A hook's `this:` annotation erases the methods surface](FIXED/BUG-006-a-hook-s-this-annotation-erases-the-methods-surface.md) | — | fixed 0.35.2, `d31a585` |

## Filing one

- take the next free id from the line above, then bump that line
- one file per bug: `BUG-0NN-short-slug.md`, starting `# BUG-0NN: <title>`
- add the rows as they become known: `**Found:**`, `**Symptom:**`, `**Root cause:**`,
  `**Fix:**`, `**Tests:**` — the detail is the point, it is why anyone reads this
- when it is fixed: move the file into `FIXED/` and say how in the Status column
  (release and, where there is one, the commit)
