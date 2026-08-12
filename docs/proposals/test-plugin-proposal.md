# posipaki: Test Plugins

> **Status**: Draft proposal.
> **Depends on**: `actor-plugin-system.md` (`addPlugins` in spawn opts),
> `define-actor-proposal.md` (unified spawn API).

## Summary

Replace manual test wiring with two plugins passed via `addPlugins`:
a per-actor **message collector** and a global **root tracker** for cleanup.

## Motivation

Current test pattern:

```ts
const { collector, messages, resolved } = makeCollector<ResponseMessage>(spec);
const root = await Connector.spawn(args, { name: 'test', toParent: collector });
track(root);

const result = await resolved();
expect(result.ok).toBe(true);
// ... assertions ...

await stop();  // or afterEach loop with activeRoots[]
```

Three separate concerns bolted together: collector via `toParent`, tracker via
manual array, cleanup via `afterEach` loop.  Plus `{ fromName, fromId }` noise
on every `proc.send()`.

## Target DX

```ts
const tracker = createRootTracker();
afterEach(() => tracker.stopAll());

it('does something', async () => {
  const collector = createCollector<ResponseMessage>({ type: 'RESPONSE' });

  const root = await Connector.spawn(args, {
    name: 'test',
    addPlugins: [tracker.plugin, collector.plugin],
  });

  const result = await collector.resolved();
  expect(result.ok).toBe(true);
  expect(collector.messages).toHaveLength(1);
});
```

Zero manual wiring.  `toParent`, `track()`, `activeRoots`, `afterEach` loop —
all gone.  Just plugins.

## `addPlugins` vs actor `plugins`

`addPlugins` in spawn opts are **non-overridable** by children.  The actor's own
`plugins` config can still transform inherited parent plugins, but `addPlugins`
always flow down — children can't remove them.

This is critical for test plugins: you don't want a child connector accidentally
stripping the collector or tracker.

```
addPlugins: [tracker, collector]   → children inherit, can't override
plugins: appendPlugins(logger)     → children can transform/replace
```

## API

### `createCollector(filter, opts?)`

Factory returning `{ plugin, messages, resolved }`:

```ts
function createCollector<M extends Message>(
  filter: MatchSpec | MatchSpec[],
  opts?: {
    timeoutMs?: number;
    scope?: string | RegExp;   // default: root actor only (no children)
  },
): {
  plugin: ActorPlugin;
  messages: M[];
  resolved(): Promise<{ ok: boolean; detail?: string }>;
  next(filter: MatchSpec | MatchSpec[], opts?: { timeoutMs?: number }): Promise<{ ok: boolean; detail?: string }>;
  reset(filter?: MatchSpec | MatchSpec[]): void;
}
```

#### Matching: shallow by default

Only fields present in the filter are checked.  Extra fields on the message
are ignored:

```ts
// Matches { type: 'RESPONSE', choice: {...}, history: [...] }
// because it only checks the 'type' field
createCollector({ type: 'RESPONSE' });

// Matches { type: 'ERROR', code: 500 } but not { type: 'ERROR', code: 400 }
createCollector({ type: 'ERROR', code: 500 });
```

#### Complete callback interface

For tests that need full context, the collector provides a callback form:

```ts
createCollector((msg, history, fromName) => {
  // msg:      the full message that matched
  // history:  all messages collected so far (across all emitters)
  // fromName: name of the actor that emitted this message
  return msg.type === 'RESPONSE' && msg.choice.finish_reason === 'stop';
});
```

#### Emit tracking per emitter

Because plugins inherit to children, the collector sees emits from the root
actor AND all descendants.  The plugin tracks **separate histories per emitter**
internally, keyed by `fromName`.

The `history` passed to the callback is the **merged** history across all
emitters (chronological).  For per-emitter inspection, use `collector.byEmitter`.

#### Scope: root-only by default

By default, `scope` is the root actor's name — only its emits are collected.
Children's emits are tracked (for the merged history) but don't trigger
matching or count toward `resolved()`.

```ts
// Only root actor emits
createCollector({ type: 'RESPONSE' });

// Specific child
createCollector({ type: 'RESPONSE' }, { scope: 'connector' });

// Child name pattern
createCollector({ type: 'RESPONSE' }, { scope: /^reflector:connector/ });

// Everything (root + all children)
createCollector({ type: 'RESPONSE' }, { scope: '*' });
```

#### `resolved()` contract

Settles when all required matches are observed (from in-scope emitters).
On timeout or actor exit, settles with `ok: false` and a human-readable detail
listing what was expected vs received.

`messages` is a live reference — readable at any point, not just after
`resolved()`.

#### Restartability

Collectors are restartable — a common pattern is wait, act, wait again:

```ts
const collector = createCollector({ type: "TOOL_CALLS" });

// First wait: model requests tools
await collector.resolved();
root.send({ type: "APPEND", message: { role: "tool", ... } });

// Second wait: model responds after tool results
await collector.next({ type: "RESPONSE" });
```

`messages` accumulates across restarts (full history, never cleared).
Only the match state resets.

- **`next(filter, opts?)`** — waits for new matches against the accumulated
  `messages` using a new filter.  Considers all messages (old + new).
  If matches are already satisfied by existing messages, resolves immediately.
  Same timeout semantics as `resolved()`.

- **`reset(filter?)`** — resets match state.  If a new filter is provided,
  the next `resolved()` or `next()` uses it.  If omitted, keeps the current
  filter but re-evaluates from scratch against accumulated messages.


### `createRootTracker()`

Factory returning `{ plugin, stopAll }`:

```ts
function createRootTracker(): {
  plugin: ActorPlugin;
  stopAll(): Promise<void>;
}
```

The plugin hooks `afterStart` to register `this.ctx` in an internal `Set`.
`stopAll()` sends `{ type: 'STOP' }` to every registered ctx and clears the
set.  Exited processes are silently skipped (try/catch).

## Design notes

### Plugin identity

Both factories produce **named** function plugins so the framework's
deduplication works.  Passing the same plugin twice is harmless.

### Multiple collectors on one actor

A single actor can carry multiple collectors — one per message type:

```ts
const resp = createCollector({ type: 'RESPONSE' });
const err  = createCollector({ type: 'ERROR' });

const root = await Actor.spawn(args, {
  addPlugins: [tracker.plugin, resp.plugin, err.plugin],
});
```

Each collector independently tracks its own spec.  No interference.

### `stopAll` implementation

The plugin stores `this.ctx` during `afterStart`.  `this.ctx` is the raw
`ProcessCtx` which has `send(msg: InMessage | StopMessage, from?: SenderInfo)`.
`stopAll()` calls `ctx.send({ type: 'STOP' })` on each stored ctx.

### Why not a spawn wrapper?

The tracker could be a `spawnAndTrack()` wrapper instead of a plugin.  But a
plugin composes: you pass it once in `addPlugins` and it works regardless of
how the actor is spawned (standalone, fork, spawnAsChild).  No special spawn
function needed.

## Migration path

Before:

```ts
const { collector, messages, resolved } = makeCollector<M>(spec);
const root = await Actor.spawn(args, { toParent: collector });
track(root);
// ... resolved(), assertions, stop()
```

After:

```ts
const collector = createCollector<M>(spec);
const root = await Actor.spawn(args, { addPlugins: [tracker.plugin, collector.plugin] });
// ... collector.resolved(), collector.messages, assertions
// cleanup handled by afterEach(() => tracker.stopAll())
```

The old `makeCollector` module in email-agent (`src/test-helpers/message-collector.ts`)
can be re-exported from posipaki as `posipaki/testing` once this lands.

## Open questions

1. **Per-emitter API**: should `collector.byEmitter` be a `Map<string, M[]>` or
   a method `collector.emits(name)`?  Leaning toward `Map` — simpler, iterable.

2. **Callback + filter**: can you combine a filter object AND a callback?
   Filter narrows first, callback refines.  Or are they mutually exclusive?
   Mutually exclusive is simpler.

3. **`scope` for tracker**: does the root tracker need scope too?  Probably
   not — it always tracks the process it's attached to, and `stopAll()` is
   the only operation.
