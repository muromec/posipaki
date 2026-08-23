# Migration Guide: Plugin Install API

**Target:** posipaki plugin authors migrating from the old monkey-patched
`ProcessCtx` to the new structured `ActorContext`.

**Related proposal:** [Plugin Install API](../proposals/plugin-install-api.md)

## Summary of changes

| Old                              | New                                      |
| -------------------------------- | ---------------------------------------- |
| `install(ctx: any)`              | `install(self)` — typed `ActorContext`   |
| `ctx.onMessage?.(fn)`            | `self.hooks.onMessage(fn)`               |
| `ctx.onEmit?.(fn)`               | `self.hooks.onEmit(fn)`                  |
| `ctx.onChildExit?.(fn)`          | `self.hooks.onChildExit(fn)`             |
| `ctx.onStart?.(fn)`              | `self.hooks.onStart(fn)`                 |
| `ctx.onStopRequested?.(fn)`      | `self.hooks.onStopRequested(fn)`         |
| `ctx.onError?.(fn)`              | `self.hooks.onError(fn)`                 |
| `ctx.onEnd?.(fn)`                | `self.hooks.onEnd(fn)`                   |
| `ctx.decorate?.(key, val)`       | `self.decorate(key, val)`                |
| `ctx.pname`                      | `self.name`                              |
| Raw `ctx` (fork, toParent, etc.) | `self.ctx`                               |
| _(new)_                          | `self.reflection.register(name, method)` |

## Step-by-step

### 1. Rename the parameter

```diff
- install(ctx: any) {
+ install(self) {
```

The new parameter is typed as `ActorContext` — no `any` needed. You can omit
the type annotation entirely; it's inferred from `ActorPlugin`.

### 2. Move hook registrations into `self.hooks`

```diff
- ctx.onMessage?.((msg, sender) => { ... });
+ self.hooks.onMessage((msg, sender) => { ... });

- ctx.onEmit?.((msg) => { ... });
+ self.hooks.onEmit((msg) => { ... });

- ctx.onChildExit?.((name) => { ... });
+ self.hooks.onChildExit((name) => { ... });

- ctx.onStart?.((state) => { ... });
+ self.hooks.onStart((state) => { ... });

- ctx.onStopRequested?.(() => { ... });
+ self.hooks.onStopRequested(() => { ... });

- ctx.onError?.((err) => { ... });
+ self.hooks.onError((err) => { ... });

- ctx.onEnd?.((reason) => { ... });
+ self.hooks.onEnd((reason) => { ... });
```

No more `?.` — these methods are always present.

### 3. Move `decorate`

```diff
- ctx.decorate?.('label', 'hello');
+ self.decorate('label', 'hello');
```

### 4. Replace `ctx.pname` with `self.name`

```diff
- console.log(`[${ctx.pname}] starting`);
+ console.log(`[${self.name}] starting`);
```

### 5. Raw ProcessCtx is at `self.ctx`

If your plugin accesses the raw process context (for `fork`, `toParent`,
`sendSelf`, `parentName`, `parentId`), use `self.ctx`:

```diff
- const child = ctx.fork?.(childFn, 'worker', args);
+ const child = self.ctx.fork(childFn, 'worker', args);
```

### 6. Reflection methods (new)

Plugins can now register reflection methods callable via
`proc.$reflection['pluginName.methodName']()`:

```ts
install(self) {
  self.reflection.register('ping', function () {
    // `this` is the full ActorContext
    return `pong from ${this.name}`;
  });
}
```

The method name is automatically prefixed with the plugin name to avoid
collisions. The callback's `this` is typed as `ActorContext` — no `any` cast
needed for `this.state`, `this.name`, `this.$child`, etc.

## Complete example

```ts
// Before
const myPlugin: ActorPlugin = {
  name: "myPlugin",
  install(ctx: any) {
    ctx.onMessage?.((msg) => {
      console.log(`[${ctx.pname}] received ${msg.type}`);
    });
    ctx.decorate?.("logger", { name: ctx.pname, count: 0 });
  },
};

// After
const myPlugin: ActorPlugin = {
  name: "myPlugin",
  install(self) {
    self.hooks.onMessage((msg) => {
      console.log(`[${self.name}] received ${msg.type}`);
    });
    self.decorate("logger", { name: self.name, count: 0 });
  },
};
```

## TypeScript notes

- **No `any` needed.** `install(self)` is fully typed. Methods are
  non-optional — no `?:` or `?.` required.
- **Hook callbacks are typed.** `self.hooks.onMessage(fn)` expects
  `(msg: InMsg, sender: SenderInfo) => HookResult | Promise<HookResult>`.
  The generics flow from the plugin's `ActorPlugin<InMsg, OutMsg, State>`
  declaration.
- **`self.state` is `State`** (from the plugin's generic, default `unknown`).
  Cast as needed: `(self.state as MyState).field`.
- **`self.reflection.register` callbacks** receive `this: ActorContext<...>`
  with full actor API access.
