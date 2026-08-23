# posipaki: Actor Plugin System

> **Status**: In design. Decisions being made; not yet implemented.

## Summary

Plugins are **config transforms** — functions `(config) => config` that modify an
actor's `ActorConfig` before `setup` runs. They use `mergeConfigs` / `chainHook`
to add hooks without stepping on each other. Plugins **inherit along the actor
tree** by default.

```ts
const debugLogger: ActorPlugin = (cfg) =>
  mergeConfigs(cfg, {
    onMessage(msg, sender) {
      console.log(`[${this.name}] ← ${msg.type} from ${sender.fromName}`);
    },
    onError(err) {
      console.error(`[${this.name}] error:`, err);
    },
  });
```

## Design decisions (2026-08-11)

### 1. Plugin identity is the function name

Deduplication uses `Function.name`. Anonymous plugins (arrow functions, inline
lambdas) get `console.warn("plugin has no name, dedup won't work")`.

### 2. Default inheritance: append (was: replace)

| Config                        | Behaviour                                   |
| ----------------------------- | ------------------------------------------- |
| `plugins: undefined`          | Inherit all parent plugins                  |
| `plugins: addPlugins(p)`      | `[...parentPlugins, ...mine]` — the default |
| `plugins: replacePlugins(p)`  | `[...mine]` — opt-in to replace             |
| `plugins: (parents) => [...]` | Custom transform                            |

Two explicit helpers make intent clear:

```ts
import { addPlugins, replacePlugins } from "posipaki";

// Append to parent plugins (default)
plugins: addPlugins(myPlugin);

// Replace parent plugins entirely
plugins: replacePlugins(myPlugin);
```

### 3. `addPlugins` in spawn opt

All three spawn entry points gain `addPlugins` in their opts, always appended
after config resolution and deduplicated:

````ts
// Standalone spawn
Actor.spawn(args, { name?, toParent?, addPlugins? })

// Child via fork (inside actor context)
this.fork(Actor, args, { name?, addPlugins? })

// Child from outside (e.g. test harness)
Actor.spawnAsChild(ctx, args, { name?, addPlugins? })

### 3b. `addPlugins` are non-overridable

Unlike `plugins` on the actor config (which children can transform via
`appendPlugins`/`replacePlugins`), plugins passed via `addPlugins` in spawn opts
**always flow to children and cannot be removed or replaced**.  This is for
cross-cutting concerns that must apply to the entire subtree — test collectors,
security policies, global loggers.

```ts
// Child CANNOT strip these:
Actor.spawn(args, { addPlugins: [auditLog, rateLimiter] })

// Child CAN transform these:
const Child = defineActor({
  plugins: replacePlugins(myPlugin),  // strips parent plugins, keeps addPlugins
})
````

Resolution order: `resolvePlugins(config.plugins, parentPlugins)` → `+ opts.addPlugins` → dedup.
Children receive `parentPlugins = resolved(config.plugins, parentPlugins)` and
`addPlugins` verbatim.

### 4. `parentPlugins` folded into opts

`spawnAsChild` currently has a 4th positional parameter `parentPlugins?: ActorPlugin[]`.
This moves into `opts`:

```
// before
spawnAsChild(ctx, args, opts?, parentPlugins?)

// after
spawnAsChild(ctx, args, opts?: { name?, addPlugins? })
```

`self.fork()` currently passes parent plugins as the 4th param. After this
change, `self.fork()` passes them via `addPlugins` in opts, making the
mechanism the same for all callers.

### 5. Plugin resolution order

When `this.fork(ChildActor, args, opts)` runs:

1. `resolvePlugins(config.plugins, parentPlugins)` — apply the actor's transform
2. Append `opts.addPlugins` (non-overridable — children always inherit these) (if any)
3. Deduplicate by function name (warn if anonymous)
4. Each plugin transforms the child config via `assembleActor`
5. `setup` runs on the fully transformed config

## Motivation (unchanged)

Lifecycle hooks give actors fire-and-forget observability — but every actor that
wants logging still writes an `onMessage` block. That's better than per-handler
logging but still repetitive across actors.

Worse: when an actor forks a child, the parent's hooks don't follow. A
`debugLogger` on the root `reflector` actor has no visibility into the
`connector` child.

Plugins solve both:

- **Packaging**: a plugin bundles hooks into a single importable transform.
- **Inheritance**: when a parent forks a child, the child automatically
  inherits the parent's plugin chain. Observability follows the tree.
- **Composition**: `plugins: addPlugins(debugLogger, rbac({ tools: [...] }))`
  without either plugin knowing about the other.

## Future: test utilities as plugins

With `addPlugins` in spawn opts, test utilities like message collectors and
root trackers can be implemented as plugins rather than separate modules with
manual wiring:

```ts
// Instead of:
const { messages, resolved } = makeCollector(spec);
const proc = await Actor.spawn(args, { toParent: collector });
track(proc);

// Plugin approach:
const proc = await Actor.spawn(args, {
  addPlugins: [messageCollector(spec), rootTracker()],
});
```

This is a goal, not part of this proposal's implementation scope.
