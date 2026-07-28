# posipaki: Actor Tree Naming

> **Status**: Draft proposal.  No code written yet.

## Summary

Actors declare their own name at definition time.  When a parent forks a
child, the child's name is automatically prefixed to form a tree path:
`parent:child:grandchild`.  The parent can override for disambiguation, but
the default is the child's own declaration.

```ts
const Connector = defineActor({
  name: 'connector',     // ← child declares its own name
  ...
});

// Parent: fork without a name — picks it up from the definition
ctx.fork(Connector.fn)(args);        // child name: "openai:connector"

// Parent: override for disambiguation
ctx.fork(Pool.fn, 'tools')(args);    // child name: "openai:tools"

// Raw generator (no defineActor): explicit name still required
ctx.fork(rawGen, 'worker-3')(args);  // child name: "openai:worker-3"
```

## Motivation

Today the parent dictates the child's name: `ctx.fork(fn, 'connector')`.
The child has no say.  This is backwards — the child knows itself best.
It's the child's `defineActor` definition that declares what kind of thing
it is; the parent only knows what role it's playing in the parent's own
context (if that).

This also surfaces an asymmetry: `spawnAsync()` is used for root actors
and gets an explicit name, but `ctx.fork()` is used for children and is
blind to the definition's intent.

## Design

`ActorDefinition` gains an optional `name: string` field:

```ts
type ActorDefinition<Args, State, In, Out, Handlers> = {
  fn: AsyncProcessFn<Args, State, In, Out>;
  config: ActorConfig<...>;
  name?: string;      // ← NEW: the actor's preferred name
  spawn: ...;
  spawnAsChild: ...;
};
```

`defineActor` accepts an optional `name`:

```ts
type ActorConfig<...> = {
  name?: string;      // ← NEW
  // ... existing fields ...
};
```

`ctx.fork()` resolution order:

```
1. Explicit name from second argument:   ctx.fork(fn, 'tools')(args)
2. fn.name (from ActorDefinition):       ctx.fork(Connector.fn)(args)
3. fn.config.name (from defineActor):    ctx.fork(SomeActor.fn)(args)
4. Fallback:                             'child-N'
```

Once resolved, tree prefixing is automatic: `${parentName}:${resolvedName}`.

Root actors (spawned via `spawnAsync()` or `actor.spawn()`) get their name
from the caller — no prefix, no tree semantics.  They are the root.

### `ctx.fork()` signature change

```ts
// Current:
ctx.fork(fn, pname): (args: Args) => AsyncProcess<...>

// New: pname becomes optional (defaults to definition's name):
ctx.fork(fn, pname?): (args: Args) => AsyncProcess<...>
```

Backward compatible: all existing `ctx.fork(fn, 'name')` calls continue
to work unchanged.  The `name` field on the definition is only used when
`pname` is omitted.

### Naming is cheap

The name is resolved once at fork time and stored as `proc.pname` on the
`AsyncProcess` instance.  No runtime lookup, no registry, no shared state.

Plugins and hooks see the fully-qualified name via `ctx.pname`:

```ts
ctx.onMessage((msg) => {
  console.log(ctx.pname);  // "openai:connector"
});
```

## Examples

### Full tree

```ts
const ToolCaller = defineActor({
  name: 'tool-caller',
  ...
});

const Pool = defineActor({
  name: 'pool',
  ...
  onStart(args) {
    // Fork without name → child is "openai:pool:tool-caller"
    this._worker = this.fork(ToolCaller.fn)(args);
  },
});

const OpenAi = defineActor({
  name: 'openai',
  ...
  onStart(args) {
    // Fork without name → child is "openai:pool"
    this._pool = this.fork(Pool.fn)(args);
  },
});

// Root spawn:
const proc = OpenAi.spawn(args);   // proc.pname = "openai"
// proc.$child.pool → "openai:pool"
// pool.$child.tool-caller → "openai:pool:tool-caller"
```

### Disambiguation override

```ts
const Pool = defineActor({ name: 'pool', ... });

// Parent needs two pools — overrides the name:
onStart(args) {
  this._syncTools = this.fork(Pool.fn, 'sync-tools')(args);   // "openai:sync-tools"
  this._asyncTools = this.fork(Pool.fn, 'async-tools')(args); // "openai:async-tools"
}
```

### Raw generator (no defineActor)

```ts
// Raw generators don't have a name field, so explicit pname is required:
ctx.fork(someRawGen, 'my-worker')(args);  // "openai:my-worker"
```

## Checklist

- [ ] `ActorConfig` accepts optional `name: string`
- [ ] `ActorDefinition` exposes `name?: string`
- [ ] `defineActor` propagates `config.name` onto the definition
- [ ] `ctx.fork(fn, pname?)` — pname is optional, defaults to `fn.config?.name ?? fn.name`
- [ ] Tree prefixing: `${parentName}:${resolvedName}`
- [ ] Root actors get explicit name, no prefix
- [ ] Backward compat: all existing `ctx.fork(fn, 'name')` calls pass tests unchanged
- [ ] Tests: `defineActor({ name: 'x' })` → `fn.config.name === 'x'`
- [ ] Tests: `ctx.fork(NamedActor.fn)(args)` builds `parent:named`
- [ ] Tests: `ctx.fork(NamedActor.fn, 'override')(args)` builds `parent:override`
- [ ] Tests: raw generator without name needs explicit pname
- [ ] Tests: three-level tree `a:b:c`
- [ ] Update `src/index.ts` exports
- [ ] Bump minor version
