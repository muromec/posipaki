# Posipaki

The missing primitive: actor processes for JavaScript, built on generator functions
and the `[msg, sender]` tuple.

## Why

JavaScript has three ways to model async work:

- **Promises** — model a single eventual value. Great for request/response, useless
  for something with more than one outcome.
- **Observables / Streams** — model a sequence of values over time. Great for
  events, but every subscriber sees the same events and there's no back-and-forth.
- **Stores / Reactive state** — model a value that changes over time. Great for UI
  state, but they're passive — you read them, they don't talk back.

What's missing is a primitive for something that **receives messages, updates its
own state, and sends messages back** — a thing with its own lifecycle, can be started
and aborted before it resolves. 

A **process**.

```ts
const counter = defineActor({
  initialState: { count: 0 },
  handlers: {
    POKE(msg, sender) {
      this.state.count++;
      if (this.state.count >= 10) {
        this.emit({ type: "FULL" });
        this.exit("limit reached");
      }
    },
    RESET(msg, sender) {
      this.state.count = 0;
    },
  },
});
```

A process can do everything a promise, a stream, or a store can do —
but it can also fork children, pause/resume, and exit on its own terms.
And every handler receives the sender's identity in the `[msg, sender]` tuple,
so you always know *who* sent what.
Of course processes are composable into trees.

## Quick start

```ts
import { spawnAsync, defineActor } from "posipaki";

const counter = defineActor({
  initialState: { count: 0 },
  handlers: {
    POKE(msg, sender) {
      this.state.count++;
    },
  },
});

const proc = spawnAsync(counter.fn, "counter")(null);
await proc.ready();           // state is available
proc.send({ type: "POKE" });  // delivers [msg, sender] to the generator
// proc.state.count === 1     // the can be wrapped in reactive() of computed!
```

For full control, drop to generators:

```ts
import { spawnAsync, runDispatchAsync } from "posipaki";

async function* counter(ctx, { max }) {
  const state = { count: 0 };
  yield state;

  yield* runDispatchAsync(ctx.pname, async ([msg, sender]) => {
    if (msg.type === "POKE" && state.count < max) state.count++;
  });
  // ... or wait for the signal to replace it with another generator
}

const proc = spawnAsync(counter, "counter")({ max: 3 });
await proc.ready();
proc.send({ type: "POKE" });
await proc.wait();
```

## Features

- **Processes** — sync or async, same API
- **Child processes** — `ctx.fork(fn, name)(args)` spawns supervised children
- **Supervisor** — run and monitor named workers
- **Reactive state** — `proc.subscribe(cb)` notifies on every state change
- **Pause/resume** — buffer messages while idle
- **Pipe** — chain processes so each runs after the previous exits
- **xfetch** — HTTP requests as processes, with abort support
- **defineActor** — declarative config for structured actors

## Sender provenance

Every message the generator receives is a `[msg, sender]` tuple:

```ts
const [msg, sender] = yield state;
// msg:    your discriminated message
// sender: { fromName: string, fromId: symbol }
```

Messages you send via `ctx.sendSelf()` or `ctx.toParent()` are stamped automatically.

## Install

```sh
npm install posipaki
```

## API

### Processes

- `spawnAsync(fn, name)(args)` — create an async process
- `proc.ready()` — wait for initial state
- `proc.state` — current reactive state
- `proc.send(msg, sender)` — inject a message from a named sender
- `proc.subscribe(cb)` — react to state changes
- `proc.pause()` / `proc.resume()` — buffer or process messages
- `proc.wait()` — resolve when the generator completes

### Generator context

- `ctx.pname` — process name
- `ctx.id` — unique symbol
- `ctx.sendSelf(msg)` — enqueue a message to yourself
- `ctx.toParent(msg)` — send a message to the parent process
- `ctx.fork(fn, name)(args)` — spawn a child process

### Sender types

- `SenderInfo` — `{ fromName: string, fromId: symbol }`
- `WithSender<M>` — `[M, SenderInfo]`
- `WithoutSender<T>` — extracts `M` from `WithSender<M>`

## License

MIT
