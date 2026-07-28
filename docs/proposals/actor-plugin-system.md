# posipaki: Actor Plugin System

> **Status**: Draft proposal.  No code written yet.
> **Depends on**: `actor-lifecycle-hooks.md` (hooks API must land first).

## Summary

Build on the lifecycle hooks API to create a **plugin system** where reusable
observability, security, and behaviour-modifying logic can be packaged as
self-contained units and applied to actors at fork time.  Plugins are
**inherited by child actors** automatically.

A plugin is a function that receives the `ProcessCtx` and registers hooks:

```ts
const debugLogger = (): ActorPlugin => ({
  name: 'debugLogger',
  install(ctx) {
    const log = logger.for(ctx.pname);
    ctx.onMessage((msg) => log.debug(`← ${msg.type}`));
    ctx.onError((err) => log.error('actor error', err));
  },
});
```

Usage — specify plugins when defining the actor:

```ts
const MyActor = defineActor({
  plugins: [debugLogger()],
  handlers: { ... },
});
```

No changes to the actor's own code.  The plugin's hooks fire alongside
any hooks the actor defines directly.

## Motivation

Lifecycle hooks (`actor-lifecycle-hooks.md`) give actors fire-and-forget
observability — but every actor that wants logging still writes a
`hooks.onMessage(...)` block.  That's better than per-handler logging but
still repetitive across actors.

Worse: when an actor forks a child, the parent's hooks don't follow.
A `debugLogger` hook on the root `reflector` actor has no visibility into
the `connector` child, the `tools` pool, or tool workers.

Plugins solve both:

- **Packaging**: a plugin bundles multiple hooks (onMessage + onEmit +
  onError + onChildExit) into a single importable unit.
- **Inheritance**: when a parent forks a child, the child automatically
  inherits the parent's plugin chain.  Observability follows the tree.
- **Composition**: an actor uses `plugins: [debugLogger(), rbac({ tools: [...] })]`
  without either plugin knowing about the other.

## Design principles

1. **Plugins are functions from ctx to void.**  `install(ctx)` is called
   at fork time.  The plugin registers hooks on `ctx`.  That's it.
   No return value, no state, no lifecycle beyond `install`.

2. **Plugins are composed, not subclassed.**  `plugins: [A(), B()]` —
   each installs independently.  No inheritance chain, no `super`.

3. **Plugin inheritance is opt-out.**  A child inherits its parent's
   plugins by default.  The child can extend or replace the list.

4. **Plugin spec lives in code, not config.**  The plugin function is
   imported from TypeScript.  There's no YAML/JSON plugin declaration.
   Persona identity files may reference plugin names for RBAC gating,
   but the plugin implementation is always code.

## API

### Plugin type

```ts
type ActorPlugin = {
  /** Diagnostic name for logging / debugging. */
  name: string;

  /** Called at fork time.  The plugin registers hooks on `ctx`. */
  install(ctx: ProcessCtx<any, any, any, any>): void | Promise<void>;
};
```

Note: `install` receives the **same** `ProcessCtx` that the actor receives
in `initialState` and `onStart`.  The plugin can do anything the actor can
do with `ctx`: register hooks (`ctx.onMessage`, …), fork children
(`ctx.fork`), emit messages (`ctx.toParent`).

### Plugin declaration

`defineActor` gains a `plugins` field:

```ts
type ActorConfig<...> = {
  // ... existing fields ...
  plugins?: ActorPlugin[] | PluginTransform;
};

type PluginTransform = (parentPlugins: ActorPlugin[]) => ActorPlugin[];
```

Two forms:

- **`plugins: [a, b]`** — use exactly these plugins.  No inheritance.
- **`plugins: (parents) => [...parents, c]`** — inherit parent plugins,
  add `c` to the chain.

Default (when `plugins` is omitted): inherit all parent plugins unchanged.

### Inheritance

When `ctx.fork(fn, name)(args)` runs inside a `defineActor` child:

1. The framework collects the parent's resolved plugin chain (the
   post-install internal representation).
2. The child's `plugins` field is evaluated:
   - If it's an array → use that array.
   - If it's a function → call it with the parent chain as argument.
   - If it's undefined → use the parent chain unchanged.
3. Each plugin's `install(childCtx)` is called on the child.

This means:

```ts
// Root actor with debugLogger:
const Reflector = defineActor({
  plugins: [debugLogger()],
  ...
});

// Primary actor: inherits debugLogger automatically:
const OpenAi = defineActor({
  // plugins: omitted → inherits [debugLogger]
  ...
});

// Connector: inherits debugLogger + adds its own timeout guard:
const Connector = defineActor({
  plugins: (parents) => [...parents, timeoutGuard({ ms: 30_000 })],
  ...
});

// ReplInput: wants NO plugins from parent:
const ReplInput = defineActor({
  plugins: [],   // empty array → no inheritance
  ...
});
```

### Fork-time override

When calling `this.fork()` in actor code, a third parameter allows
per-fork plugin overrides:

```ts
// Inherit all plugins (default):
this.fork(MyActor.fn, 'child')(args);

// Replace plugins for this fork only:
this.fork(MyActor.fn, 'child', { plugins: [debugLogger()] })(args);

// Extend parent plugins for this fork:
this.fork(MyActor.fn, 'child', { plugins: (p) => [...p, extra()] })(args);
```

This is the escape hatch for exceptional cases.  Normal usage relies on
the child's `defineActor` declaration.

## Example: debugLogger (email-agent code, not in posipaki)

```ts
import type { ActorPlugin } from 'posipaki';
import { logger } from './log.js';

export function debugLogger(opts?: { level?: 'debug' | 'info' }): ActorPlugin {
  return {
    name: 'debugLogger',
    install(ctx) {
      const log = logger.for(ctx.pname);

      ctx.onMessage((msg, sender) => {
        if (opts?.level === 'info' && msg.type === 'HEARTBEAT') return;
        log.debug(`${ctx.pname} ← ${msg.type} from ${sender.fromName}`);
      });

      ctx.onEmit((msg) => {
        log.debug(`${ctx.pname} → ${msg.type}`);
      });

      ctx.onChildExit((name) => {
        log.debug(`${ctx.pname}: child ${name} exited`);
      });

      ctx.onError((err) => {
        log.error(`${ctx.pname}: ${(err as Error).message}`);
      });
    },
  };
}
```

## Open questions

- **Should `install` be async?**  `install(ctx): void | Promise<void>` is
  async-capable.  Realistically most plugins won't need it, but it costs
  nothing to support.

- **Per-instance vs singleton plugins.**  `debugLogger()` returns a new
  plugin object per call — fine, it's cheap.  Should we support singletons
  like `debugLogger` (no call parens)?  Probably not worth the API surface.

- **Plugin ordering.**  Plugins install in declaration order.  If plugin A
  registers `onMessage` before plugin B, A's hook fires first.  This is
  deterministic and predictable.  Do we need explicit ordering primitives
  (priority numbers, before/after)?

- **TypeScript declaration merging for plugin-provided `this` properties.**
  Right now `this.log` is undefined unless the actor defines it in state.
  Fastify-style declaration merging would let `debugLogger` ship a `.d.ts`
  that adds `log: Logger` to the actor type.  Separate proposal — out of
  scope for this one.

## Checklist

- [ ] `ActorPlugin` type: `{ name, install(ctx) }`
- [ ] `PluginTransform`: `(parentPlugins: ActorPlugin[]) => ActorPlugin[]`
- [ ] `defineActor` accepts `plugins` field (array or transform)
- [ ] Plugin inheritance on `ctx.fork()`: parent chain → child
- [ ] `plugins: []` clears inheritance
- [ ] `plugins: (p) => [...p, extra()]` extends inheritance
- [ ] Fork-time override: `this.fork(fn, name, { plugins: [...] })(args)`
- [ ] Tests: plugin install called at fork time
- [ ] Tests: plugin hooks fire in order
- [ ] Tests: inheritance — child gets parent's plugins
- [ ] Tests: `plugins: []` blocks inheritance
- [ ] Tests: `plugins: (p) => [...p, extra]` extends parent chain
- [ ] Tests: fork-time override replaces plugins for that child only
- [ ] Migration: port one email-agent logger to debugLogger plugin
- [ ] Update `src/index.ts` exports
- [ ] Update README with plugin section
- [ ] Bump minor version
