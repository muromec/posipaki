# posipaki: `_from` field on child messages

## Summary

Stamp every message from a child process with a `_from` field containing the
child's `id` (its `Symbol`).  This lets the parent know which child sent a
message — the same way Erlang's runtime automatically includes the sender's
PID on every message.

## Motivation

posipaki makes it easy to fork child processes, but the parent has no way
to tell which child sent a message.  The child's identity is lost between
`ctx.toParent(msg)` and the parent's dispatch loop.  This makes common
patterns unnecessarily hard:

- **Worker pools** — an actor that spawns N identical workers and
  round-robins tasks to them needs to know when a worker responds so it
  can mark that specific worker as free.  Without `_from`, the pool has to
  guess based on internal state ("any worker is busy, so this must be a
  worker response").

- **Supervisors** — a supervisor that restarts children needs to know
  which child failed.  Today `EXIT` carries `pid`, but other error
  messages from children don't.

- **Request/response matching** — if a parent sends requests to multiple
  children and expects responses, it can't correlate them without the
  child adding an explicit identifier to every message.

## Current behavior

In `Process.fromChild` (and `AsyncProcess.fromChild`):

```js
fromChild(msg) {
    if (msg.type === "EXIT")
        this.children = this.children.filter((p) => p.id !== msg.pid);
    this.send(msg);
}
```

The child's `msg` arrives in the parent's dispatch loop with no provenance.
The `EXIT` message is special — the child's `_watchExit` wrapper puts `pid`
on it.  All other messages carry no child identity.

## Proposed API

### Implementation (in `AsyncProcess.fork`)

```js
fork(fn, pname) {
    return (args) => {
        const child = new AsyncProcess(
            fn,
            pname,
            (msg) => this.fromChild(msg, child),  // pass child reference
        );
        this.children.push(child);
        child.start(args);
        return child;
    };
}
```

### Implementation (in `AsyncProcess.fromChild`)

```js
fromChild(msg, child) {
    if (msg.type === "EXIT")
        this.children = this.children.filter((p) => p.id !== msg.pid);
    msg._from = child.id;
    this.send(msg);
}
```

### Usage

```ts
// Parent dispatch loop:
yield* runDispatch("parent", (msg) => {
    if (msg._from === worker1.id) {
        // message from worker1
        worker1Busy = false;
    }
    // ...
});
```

Or for the pool case, the pool simply checks `slots.find(s => s.proc.id === msg._from)` — no guessing, no `route` function, no implicit state machine.

## Backward compatibility

Fully backward-compatible.  `_from` is an extra field — existing code that
ignores it continues to work.  The only risk is a name collision if someone
already uses `_from` in their message types, but the underscore prefix
follows the convention for internal/private fields.

The `fromChild` signature changes from one parameter to two.  If anyone has
subclassed `AsyncProcess` and overridden `fromChild`, they'd need to update.
This is unlikely — `fromChild` is an internal method.

## Open questions

- **Should it be `_from` or `_pid`?**  `_from` reads naturally in code
  (`msg._from`), matching Erlang's mental model.  `_pid` is more precise
  about what it contains (a process id).  Going with `_from`.

- **Should `toParent` also be updated?**  No.  The child doesn't need to
  know about `_from` — it's added by the parent on receipt.  The child
  just calls `ctx.toParent(msg)` as before.

- **TypeScript types?**  `Message` could gain an optional `_from?: symbol`
  field.  Or a separate `ChildMessage extends Message { _from: symbol }`
  type could be used by parents that care.  The latter is more precise but
  adds complexity.  Adding it to `Message` is simpler and matches the
  runtime reality (every message from a child will have it).

## Implementation checklist

- [ ] Update `AsyncProcess.fork` to pass `child` to `fromChild`
- [ ] Update `AsyncProcess.fromChild` to accept `child` and stamp `msg._from`
- [ ] Same for `Process.fork` / `Process.fromChild`
- [ ] Add `_from?: symbol` to `Message` type
- [ ] Test: child sends a message, parent sees `msg._from === child.id`
- [ ] Test: multiple children, parent can distinguish them
- [ ] Test: `EXIT` still works and carries `_from` in addition to `pid`
- [ ] Bump minor version