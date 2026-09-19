# Migration Guide: Reflection Methods Are Async

**Target:** anyone calling or declaring a reflection method
(`proc.$reflection.*`).

**Related proposal:** [Actor Reflection RPC](../proposals/actor-reflection-rpc.md)

## What changed

A reflection call now answers with a promise, always. Locally the method is
invoked and its value wrapped; over a wire the answer travels as a frame first.
The point is that the call reads the same in both cases — a caller that had to
know which of the two it was holding would be reading the shape of the
deployment, not the answer.

Two consequences:

- **Calling** one: `await proc.$reflection.something(args)`.
- **Declaring** one: it returns a promise. `ReflectionMethod` is
  `(...args) => Promise<unknown>` and `ReflectionOptions` holds every declared
  method to that contract, so a method written as `() => number` no longer
  compiles — write it `async`.

`defineActor` wraps whatever a method returns, so a method that has its value
already still fulfils the contract at runtime; the type contract is what keeps
authors writing it that way.

## Step-by-step

### 1. Await the call

```diff
-const count = proc.$reflection.getCount();
+const count = await proc.$reflection.getCount();
```

### 2. Write the method as async

```diff
 declare module "posipaki" {
   interface ActorReflection {
-    "myPlugin.getCount": () => number;
+    "myPlugin.getCount": () => Promise<number>;
   }
 }

 const myPlugin: ActorPlugin = async (config) =>
   mergeConfigs(config, {
     $reflectionMethods: {
-      "myPlugin.getCount"() {
+      async "myPlugin.getCount"() {
         return this.state.count;
       },
     },
   });
```

### 3. The bundled inspect methods

| Method                | Returns now                     |
| --------------------- | ------------------------------- |
| `inspect.getTree`     | `Promise<TreeNode>`             |
| `inspect.getState`    | `Promise<unknown>`              |
| `inspect.find`        | `Promise<AnyProcess \| null>`   |
| `inspect.exit`        | `Promise<void>`                 |

A helper that wrapped a synchronous `inspect.find` becomes `async` with it.

## Reading a process that came over a wire

A reflection method may return a process. Over a wire it travels as a reference —
an id this connection handed out and the name the far side knows it by — and
parses into a `RemoteProcess`, which is a handle rather than the process itself:
`send`, `subscribe`, `state`, `$reflection`, `wait`, `stop`, `pause`, `resume`,
`release`, `tune` and `isConnected()`. It is not a node in this side's tree
(`getTree` walks the far side and gives that tree), and a call can come the other
way: a process of your own that the far side holds answers the methods it announced,
whichever end asks. Code that found a process by walking a tree and then called into
it has to go through the handle.

Nothing is said about a process that crossed until something here asks: subscribing
to what it says or what it holds is what starts that category crossing, `wait()`
asks for its end, and `tune()` asks for any of the three outright.
