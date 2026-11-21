# BUG-012: A durable actor with an empty log refuses its first request

**Found:** 2026-11-20, wiring `posipaki-durable-actor` 0.3.1 into prsquare-sign's
document authority: a freshly created journal accepted no operations at all, and
the first one threw `this process folded to nothing`.

**Symptom:** spawning an authority over a log with no records in it is quiet and
gives a public state of `null`; the first `ADD_RECORD` throws, nothing is
written, and a caller that is waiting for its answer hears only the process
ending.  For a document whose log starts empty — which is every new document —
the actor can never take its first record, so the authority is useless exactly
where it is first needed.

**Root cause:** an empty log folds to `null`, and `ADD_RECORD` refuses to
proceed from it (`src/record.ts:117`):

```ts
const state = this.state.public.state;
if (state === null) throw new Error('this process folded to nothing');
const verdict = spec.filter(state, request.request);
```

The throw is honest about the type rather than the design: `filter(state,
request)` takes a non-null `S`, so a fold of nothing has nothing to judge a
request against.  What is missing is a way to have a state before the first
record: `setup` folds what the log holds and nothing else (`src/record.ts:76`),
and the only argument an authority is given is the log itself
(`AuthoritativeArgs<R> = { log }`, `src/record.ts:28`).  So the package quietly
assumes every log begins with a record, and neither the type nor the docs say
so.

**Workaround, in the caller:** prsquare-sign's log channel hands the actor one
no-op record (`{ type: "JOURNAL_OPENED" }`) when the file is empty — never
written to disk, never mirrored to a client, ignored by the spec's `reduce`.
It works, and it is a fact only that one channel knows: the next consumer of the
package will hit the same wall and invent its own.

**Fix:** neither of the two above was needed.  The empty fold is an ordinary state: `filter` and `map` are handed
`S | null` (`packages/durable-actor/src/interface.ts`), `setup` still folds only what the log holds, and `ADD_RECORD`
no longer throws on a null state (`src/record.ts`) — the first request of a new journal is judged and mapped against
nothing, and the record it becomes builds the state.

No initial state was added.  A spec that wants a value before the first record writes it in `reduce`'s `null` case,
which is where it already lives; a second place to put it would be a second answer to "what is this actor's state".

The same sitting removed the `map` law.  Nothing in the package asks one request to map to the same record twice:
the authority matches an answer against the record the log hands back, and a follower that guesses says which record
came back for which request through `producedFrom`.  `LAWS` is now `fold`, `diff`, `refusal` and `effect`, and
`packages/durable-actor/src/conformance.test.ts` carries a spec whose `map` stamps a counter to prove it.

**Tests:** `src/record.test.ts`, "takes its first request when the log holds nothing" — red first, the process ended
and the caller heard nothing; and the "counter that stamps the moment" case, which the `map` law refused before it
was removed.  The workaround in the caller (a no-op genesis record) can go.
