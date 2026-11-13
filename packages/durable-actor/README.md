# posipaki-durable-actor

An actor whose state is the fold of a durable record log, and whose only words are whether it took a request.

```ts
const counter = makeDurableActor(counterSpec);  // owns the log: filters, writes, folds
const follower = makeDurableProxyActor(counterSpec);  // follows it, forwards requests
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
  diff(before: S | null, after: S): R[];                   // the way back, as records
  producedFrom?(request: Q, record: R): boolean;           // did the authority make that of this
}
```

- **filter gates map.** A `refuse` writes nothing; a `pass` means `map` is called exactly once.
- **map is pure.** Same state, same request, same record — twice. A record's moment and ids belong to whoever
  builds the request, so a replay builds what the live run built.
- **diff inverts reduce.** `reduce(before, diff(before, after))` is `after`, for every adjacent pair — which
  forces the state to remember what its records said (`counter.ts` keeps `by`, the ticket keeps `movedBy`).
- **producedFrom is optional.** A follower that shows a record before the authority has written it needs to know
  which record came back for which request. It defaults to the record `map` builds, compared whole; a spec whose
  records the authority stamps compares on the field that survives, usually an id the request carried.

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

`makeDurableProxyActor(spec, { mode })` folds that channel and sends requests on. What it sends through is one of
two things, and they differ in one way: whether the medium can say *taken* back.

```ts
type Request<Q, E> = (request: Q) => Promise<void>;   // resolves taken, rejects with the refusal
type Upstream<Q, E> = Request<Q, E> | Channel<Q, string>;  // a channel only carries
```

A process is the shortcut: handed to a follower it becomes a request in `optimistic` mode and a channel in
`deferred`, because a guess is taken back by an answer and a follower that makes no guesses has none to take back.
`requesting(process)` is that same process asked as a call, for a follower that wants the answer in either mode.

```ts
const follower = makeDurableProxyActor(spec, { mode: 'deferred' });
await follower.spawn({ upstream: authority, source: mirrorChannel(authority, spec) });
```

What the two modes promise:

- `deferred` (default) shows nothing until the record has come back, and passes on what the medium said about the
  request. Through a channel nothing comes back, so the caller hears the record and a refusal is silence.
- `optimistic` shows the record it would ask for at once and answers yes; if the authority refuses, that guess is
  dropped, the remaining guesses are replayed over the fold without it, and the caller is told.

Both keep the requests in flight in one queue with the records that arrive: a record that matches the oldest
request settles it, and one that does not is held behind it until everything asked earlier has settled. A follower
attaches to what it asks when it was handed a process — so an authority with nobody else holding it stays up.

A follower follows anything with a state and a `send` — an authority, or another proxy. A chain of them is the demo.

The live one is the docs page: three 2×2 boards, one owning the log and a follower either side, four wires between
them that can be carried, slowed or cut.  It lives in the docs tree (posipaki-docs, `src/durable.js`); what is here
is the spec it runs (`demo/shapes.ts`) and the test that drives the same chain without a browser
(`demo/chain.test.ts`).

```sh
bun test demo/chain.test.ts
```

## What this is not

- It is not a database. The log is whatever channel you give it — a journal file, a socket, `log.ts` for tests.
- It is not a consensus protocol. Two writers on one log is a question this does not answer.
- A follower attaches to a state: spawn it once the process it follows has folded.
