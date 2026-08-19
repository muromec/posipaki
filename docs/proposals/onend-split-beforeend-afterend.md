# posipaki: Split `onEnd` into `beforeEnd` and `afterEnd`

> **Status**: Implemented.

## Summary

Replace the single `onEnd(reason)` lifecycle hook with two hooks that let an
actor choose *when* it frees resources relative to the EXIT signal it sends to
its parent:

- **`beforeEnd(reason)`** — fires after the dispatch loop ends but **before**
  the actor emits EXIT to its parent (and before children are STOPped). Use
  for teardown that must complete before the parent can consider the actor
  gone: flush a checkpoint, close a network connection, announce an offline
  status.
- **`afterEnd(reason)`** — fires **after** the actor emits EXIT to its parent.
  Use for best-effort cleanup that must not delay the exit signal.

`onEnd` is removed outright, with no deprecation shim. It has a handful of
downstream usages and two internal uses in this repo's test-plugin.

## Motivation

Today `onEnd` has a single, undocumented timing. In the current end-of-life
sequence it runs after the dispatch loop exits but *before* `pvtWatchExit`'s
`finally` broadcasts STOP to children and emits EXIT to the parent:

```
dispatch loop (STOP → onStopRequested → agreeToStop; child EXIT → onChildExit)
loop exits when done
onEnd(reason)              ← before children STOP, before EXIT
generator returns
finally: toAllChildren(STOP)   (fire-and-forget)
         toParent(EXIT)
```

That single position is wrong for two different kinds of teardown:

- **Teardown that must precede EXIT** — e.g. flushing a checkpoint file so a
  replacement actor resumes from the right point — is correct here, but it
  *blocks* the EXIT signal. A slow "announce offline" call delays the parent's
  knowledge that the child is gone.
- **Teardown that should not block EXIT** — best-effort cleanup — has nowhere to
  go *after* EXIT, so authors either inline it before EXIT (blocking) or skip
  it.

Splitting the hook gives each category a home and makes the timing explicit.

## Lifecycle order

Proposed end-of-life order (see the cascading-stop proposal for the middle):

```
dispatch loop ...
loop exits when done
beforeEnd(reason)          ← pre-EXIT teardown
[STOP children + await]    ← cascading stop (separate proposal)
toParent(EXIT)
afterEnd(reason)           ← post-EXIT teardown
```

## API

`ActorConfig` drops `onEnd` and gains two hooks with the same signature and
`reason` value (`"stopped"` for a STOP, or whatever was passed to
`this.exit(reason)`):

```ts
interface ActorConfig<...> {
  // REMOVED
  onEnd?: (reason?: unknown) => HookResult | Promise<HookResult>;

  // ADDED
  beforeEnd?: (reason?: unknown) => HookResult | Promise<HookResult>;
  afterEnd?: (reason?: unknown) => HookResult | Promise<HookResult>;
}
```

Both are optional and run through the same `callHook` chain as the other
lifecycle hooks, so plugins get `beforeEnd`/`afterEnd` the same way they get
`onEnd` today (plugin hook fires before the actor's own hook of the same name).

## Internal usage (must migrate)

`onEnd` is referenced in this repo in:

1. **`src/testing/test-plugin.ts`**
   - `messageCollector` plugin's `onEnd` — flushes pending `resolved()` waiters
     with `{ ok: false, detail: "actor exited before match" }`. Should become
     `beforeEnd`: the collector must fail waiters as soon as the actor is done,
     and must not wait for post-EXIT cleanup.
   - `rootTracker` plugin's `onEnd` — removes the root from the `roots` set.
     Should become `afterEnd`: deregister only after the root is truly gone, so
     `stopAll()` does not skip a still-tearing-down root.
2. **Plugin hook fixtures** — `src/plugins/plugins.test.ts` and
   `src/lifecycle-hooks.test.ts` assert "plugin `onEnd` fires before actor
   `onEnd`". These become the same assertions for `beforeEnd`/`afterEnd`
   (plugin hook fires before the actor's own hook of the same name).

These are the "test-utils and plugins" internal references.

## Migration

1. Rename `onEnd` → `beforeEnd` where the teardown must precede EXIT.
2. Rename `onEnd` → `afterEnd` where the teardown is post-EXIT best-effort.
3. Delete the `onEnd` type and call site; no compatibility shim.

## Backward compatibility

None. `onEnd` is removed without deprecation. Downstream consumers rename
mechanically; the internal test-plugin usages are enumerated above.

## Open questions

- Should `afterEnd` be async? A post-EXIT hook that throws can only be logged —
  the actor has already signalled EXIT and cannot propagate the error.
- Does `afterEnd` need access to children (which were already STOPped)? Lean
  "no": after EXIT the actor is semantically gone.
