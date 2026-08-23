# Plugin Install API — mergeConfigs pattern

**Status:** Implemented (0.17.0+)

## Summary

Plugins are pure config transforms. A plugin is a function `(config) => config`
that composes hooks, reflection methods, and decorators into the actor config
before the actor spawns.

```ts
type ActorPlugin<C = AnyConfig> = (config: C) => C | Promise<C>;
```

## Design

### ActorPlugin type

A plugin is a function. It receives the actor config (with all hooks and
methods already resolved from parent plugins) and returns a modified config.
Async plugins (those returning `Promise<C>`) are `await`ed together so the
generator doesn't yield between plugin installs.

### mergeConfigs

```ts
export function mergeConfigs<T extends {}>(base: T, overlay: Partial<T>): T;
```

Merges `overlay` into `base`. Hooks whose names match `/^(on|after)[A-Z]/` are
chained via `chainHook` — the overlay's hook fires _before_ the base hook.
All other keys are shallow-assigned.

`$reflectionMethods` is merged specially: keys from both base and overlay are
combined, with overlay taking precedence for same-named keys.

### Config namespaces

Plugins compose into these config keys:

| Config key                                                                  | Purpose                                     | Merge behavior                           |
| --------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------- |
| `onMessage`, `onEmit`, `onChildExit`, `onError`, `onEnd`, `onStopRequested` | Hooks                                       | `chainHook` — plugin fires before base   |
| `afterStart`, `afterStopRequested`, etc.                                    | Post-hooks                                  | `chainHook` — same pattern               |
| `$reflectionMethods`                                                        | Reflection methods (e.g. `inspect.getTree`) | Shallow merge, overlay wins on conflict  |
| `$decorate`                                                                 | Property decoration (e.g. `this.log`)       | Stored, wired onto context at spawn time |
| `methods`                                                                   | Custom methods on `this`                    | Spread into `ActorContext`               |

### Type augmentation (Fastify-style)

Plugins declare what they add to the actor context via module augmentation:

```ts
// debug-logger adds this.log
declare module "posipaki" {
  interface ActorDecorated {
    log: Logger;
  }
}

// tree-introspection adds $reflection methods
declare module "posipaki" {
  interface ActorReflection {
    "inspect.getTree": (prefix?: string) => TreeNode;
    "inspect.getState": () => unknown;
    "inspect.stop": () => void;
  }
}
```

`ActorDecorated` is intersected into `ActorContext`, so `this.log` is available
in all hooks and handlers. `ActorReflection` types `proc.$reflection`, giving
callers typed access to reflection methods.

### Plugin example: debug-logger

```ts
export function debugLogger(opts?: DebugLoggerOpts): ActorPlugin {
  const ignoreSet = new Set(opts?.ignore ?? []);
  const factory = opts?.factory ?? defaultFactory;

  return async (config) => {
    const name = config.name ?? "actor";
    const log = factory(name);

    // Always decorate this.log — even when DEBUG is empty
    let result = mergeConfigs(config, {
      methods: { ...config.methods },
      $decorate: { log },
    });

    if (matches(name, patterns())) {
      result = mergeConfigs(result, {
        onMessage(msg: Message) {
          if (!ignoreSet.has(msg.type)) log.debug(`${name} ← ${msg.type}`, msg);
        },
        onEmit(msg: Message) {
          log.debug(`${name} → ${msg.type}`, msg);
        },
        onChildExit(childName: string) {
          log.debug(`child ${childName} exited`);
        },
        onError(err: unknown) {
          log.error(`${(err as Error).message ?? err}`);
        },
      });
    }

    return result;
  };
}
```

### Plugin example: tree-introspection

```ts
export function inspect(): ActorPlugin {
  return async (config) => {
    return mergeConfigs(config, {
      $reflectionMethods: {
        ...config.$reflectionMethods,
        "inspect.getTree": function (prefix?: string) {
          const children: TreeNode[] = [];
          for (const child of Object.values(this.$child)) {
            const cr = child.$reflection as ActorReflection;
            if (typeof cr["inspect.getTree"] === "function") {
              const sub = cr["inspect.getTree"](prefix) as TreeNode;
              if (!prefix || sub.pname.startsWith(prefix)) children.push(sub);
            } else {
              const n = child.pname;
              if (!prefix || n.startsWith(prefix))
                children.push({
                  pname: n,
                  parentName: this.name,
                  children: [],
                  status: "no introspection",
                });
            }
          }
          return {
            pname: this.ctx.pname,
            parentName: this.ctx.parentName,
            children,
            status: "running",
          };
        },
        "inspect.getState": function () {
          return this.state;
        },
        "inspect.stop": function () {
          this.exit("inspector");
        },
      },
    });
  };
}
```

### Plugin usage in defineActor

```ts
const actor = defineActor({
  name: "myActor",
  plugins: [debugLogger(), inspect()],
  setup(args) { return { ... }; },
  handlers: { ... },
});
```

Plugin chain inheritance: `plugins: [a, b]` replaces the parent chain.
`plugins: (parents) => [...parents, c]` extends it. Resolved at fork time.

## Lifecycle position

Plugins install during the **augment** phase, before `setup()` generates
the actor's initial state. See [defineActor lifecycle](define-actor-proposal.md#lifecycle-order)
for the full phase ordering.

Since plugins receive the raw config object, they have no access to
`this.state` or `this.$child` — those don't exist yet. Plugins compose hooks
and reflection methods declaratively; the hooks themselves will have full
`this` access when they fire later.

## Related

- [defineActor proposal](define-actor-proposal.md)
- [Actor Reflection RPC](actor-reflection-rpc.md)
- [Actor Plugin System](actor-plugin-system.md)
