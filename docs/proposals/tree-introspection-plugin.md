# Tree Introspection Plugin

**Status:** draft

## Summary

A posipaki plugin that registers reflection methods for actor tree
introspection. Built on top of the [Actor Reflection RPC](actor-reflection-rpc.md)
mechanism. Exposes actor hierarchy, state snapshots, and graceful
shutdown via `actor.$reflection`.

## Motivation

When something goes wrong in a posipaki process tree, the operator
or persona needs to see what's running. Currently there's no
built-in way to inspect the actor hierarchy, read actor state, or
stop individual actors without sending application-level messages.

This plugin provides the equivalent of `ps` or `htop` for the
actor system — tree view, state inspection, and process control
via reflection methods.

## Design

### Registered methods

The plugin registers these methods on every actor it's installed on:

| Method       | Returns                                              | Description                                 |
| ------------ | ---------------------------------------------------- | ------------------------------------------- |
| `getTree()`  | `{ pname, parentName, children, status, startedAt }` | Actor identity and children                 |
| `getState()` | `unknown`                                            | JSON-serializable snapshot of exposed state |
| `stop()`     | `void`                                               | Graceful shutdown (calls `agreeToStop()`)   |

### Usage

```ts
import { treeIntrospection } from 'posipaki/plugins/tree-introspection';

const actor = defineActor({
  plugins: [treeIntrospection()],
  handlers: { ... },
});

const proc = actor.spawn(args);

// Query tree
const tree = await proc.$reflection.getTree();
// { pname: 'openai:butler', parentName: 'main', children: ['connector', 'tools'], status: 'running' }

// Walk recursively
for (const childName of tree.children) {
  const childTree = await proc.$reflection?.getTree(); // how to get child proc?
}

// Inspect state
const state = await proc.$reflection.getState();

// Stop
await proc.$reflection.stop();
```

### Tree walking

The consumer walks the tree by calling `getTree()` on the root, then
recursively on each child. The consumer needs references to child
processes — these are available via `proc.children` (the AsyncProcess
array) or by name lookup.

For remote actors, `getTree()` returns the local subtree from the
remote process's perspective. The host assembles the full picture
from multiple responses.

### Plugin implementation

```ts
export function treeIntrospection(): ActorPlugin {
  return {
    name: "treeIntrospection",
    install(ctx) {
      ctx.registerMethod("getTree", () => ({
        pname: ctx.pname,
        parentName: ctx.parentName ?? null,
        children: Object.keys(ctx.$child ?? {}),
        status: "running",
        startedAt: Date.now(),
      }));

      ctx.registerMethod("getState", () => {
        try {
          return JSON.parse(JSON.stringify(ctx.state));
        } catch {
          return "(state not serializable)";
        }
      });

      ctx.registerMethod("stop", () => {
        ctx.agreeToStop();
      });
    },
  };
}
```

### Tree output format

The consumer (tool) formats the tree as text:

```
root (running)
├── main (running)
│   ├── repl (running)
│   └── persona:butler (running)
│       ├── openai:butler (running)
│       │   ├── connector (running)
│       │   └── tools (running)
│       └── matrix:butler (running)
└── persona:coder-jk (running)
    └── ...
```

Actors without the plugin show as `(no introspection)`.

## Integration with remote actors

When actors run in separate processes, `getTree()` works across the
wire via the `$reflect` protocol. The remote process returns its
local subtree. The host assembles the full tree.

If the remote process doesn't have the plugin, `$reflect.method` with
`method: 'getTree'` receives `$reflect.error { code: 'unknown_method' }`.
The host shows `(remote, no introspection)` for that subtree.

## Future methods

- `getMetrics()` — message counts, processing times, memory
- `send(type, payload)` — inject an application message (dangerous, RBAC-gated)
- `restart()` — stop and re-spawn (useful for hung actors)
- `getHistory()` — recent messages processed (if ringbuffer plugin is also installed)

## Related

- [Actor Reflection RPC](actor-reflection-rpc.md) — the underlying mechanism
- [Actor Plugin System](actor-plugin-system.md)
- [Ringbuffer Debug Log](https://github.com/muromec/email-agent/blob/master/docs/ringbuffer-log-tool-proposal.md) — similar plugin + tool pattern
