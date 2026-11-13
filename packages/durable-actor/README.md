# posipaki-durable-actor

An actor whose state is the fold of a durable record log, and whose only words are whether it took a request.

```ts
const counter = authoritative(counterSpec);  // owns the log: filters, writes, folds
const follower = proxy(counterSpec);         // follows it: folds its records, forwards requests
```

Both answer the same `RecordHandle`, so a caller cannot tell which it was given.

## The spec

Four words, and they are laws rather than four unrelated functions:

```ts
type FilterResult<E = string> = { pass: true } | { refuse: E };

interface RecordSpec<S, R, Q, E = string> {
  filter(state: S, request: Q): FilterResult<E>;            // may it go on
  map(state: S, request: Q): R;                            // the record it becomes
  reduce(state: S | null, record: R): S;                   // one record onto the fold
  diff(before: S | null, after: S): R;                     // the way back
}
```

- **filter gates map.** A `refuse` writes nothing; a `pass` means `map` is called exactly once.
- **map is pure.** Same state, same request, same record — twice. A record's moment and ids belong to whoever
  builds the request, so a replay builds what the live run built.
- **reduce is the fold.** A journal in, the state out; `reduce(null, r)` is the first step.
- **diff inverts reduce.** `reduce(before, diff(before, after))` is `after`, for every adjacent pair — which
  forces the state to remember what its records said (`counter.ts` keeps `by`, the ticket keeps `movedBy`).

## The laws

`conformance` takes a case — a journal, one request the spec allows and one it refuses — and a registrar, so the
suite runs under vitest, `node:test`, a loop, or a page that draws a tick per law:

```ts
conformance(counterCase, (name, run) => it(name, run));
```

`runLaws` answers the failures instead of throwing, and `LAWS` is the list, so a runner of your own is a dozen
lines.

## Following

`mirrorChannel(authority, spec)` is the record channel from a process to its followers: the authority already
reduced the record, and `diff` says which one it was. A subscriber is given the state as a snapshot where it
attaches and one record per change after it — a state tick that says nothing new is not a record.

`proxy(spec)` folds that channel and forwards requests. Two modes, and the difference is when a caller sees the
state move:

- `deferred` (default) says nothing until the authority has written the record and it has come back;
- `optimistic` reduces the record it would ask for at once and answers yes, then forwards; if the authority
  refuses, the fold goes back and the caller is told (`rolled back: …`).

A proxy follows anything with a state and a `send` — an authority, or another proxy. A chain of them is the demo.

## The demo

`demo/index.html` is three 2×2 boards: the first owns the log, the second defers to it, the third guesses. Pick a
figure, click a box; click a filled box to lift it; two figures of the same shape and colour clear the board. The
channels between the boards can be cut, which is what makes the shape visible: a cut board stops moving, and a
healed one is re-attached from the state where it finds the board.

```sh
bash demo/build.sh    # one bundle, no dev server
open demo/index.html
```

## What this is not

- It is not a database. The log is whatever channel you give it — a journal file, a socket, `log.ts` for tests.
- It is not a consensus protocol. Two writers on one log is a question this does not answer.
- A follower attaches to a state: spawn it once the process it follows has folded.
