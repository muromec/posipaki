# Parent Identity on ProcessCtx

**Status:** draft

## Motivation

When a process receives a message, it knows who sent it via the `sender` tuple
(`{ fromName, fromId }`).  But it has no way to know whether that sender is
its *parent* — the process that spawned it.

Currently the only way to identify the parent is to capture `sender.fromId`
from the first received message and hope it's the parent.  This is fragile:
if the parent never sends a message, the child never learns its identity.

## Design

Add two fields to `ProcessCtx`:

```ts
interface ProcessCtx<Args, State, InMsg, OutMsg> {
  pname: string;
  id: symbol;
  parentName: string | null;   // NEW
  parentId: symbol | null;     // NEW
  // ... rest unchanged
}
```

**Root actors** (spawned via `spawnAsync` with no parent):
`parentName = null`, `parentId = null`.

**Forked children** (via `ctx.fork`):
Set to the parent's `pname` and `id`.

## Usage

```ts
const child = defineActor({
  handlers: {
    PING(msg, sender) {
      if (sender.fromId === this.ctx.parentId) {
        // Message from my parent
      } else {
        // Message from a child or other source
      }
    },
  },
});
```

The parent identifies its children via `childProc.id` (already exposed on
`AsyncProcess`):

```ts
const child = ctx.fork(childFn, "child")(args);

// In a handler:
if (sender.fromId === child.id) {
  // Message from my child
}
```

## Implementation

1. Add `parentName: string | null` and `parentId: symbol | null` to `ProcessCtx`
2. In `spawnAsync` → `start()`: set both to `null` (root actor)
3. In `fork()` → `start()`: set both to `this.pname` and `this.id` (parent)
4. Tests: root has null, forked child has parent's values, child can
   compare `sender.fromId === ctx.parentId`

## Relationship to remote actors

When a child is spawned remotely (see [Actor Remote
Spawning](actor-remote-spawning.md)), the `$init` wire message carries
`parentName` and `parentIdName` so the remote child can reconstruct its
parent identity:

```json
{"$init": {
  "parentName": "root",
  "parentIdName": "root",
  "... other args ..."
}}
```

The remote child sets `ctx.parentName = $init.parentName` and
`ctx.parentId = Symbol.for($init.parentIdName)`.  Messages from the host
carry `fromIdName` matching `parentIdName`, so `sender.fromId ===
ctx.parentId` works across the wire.
