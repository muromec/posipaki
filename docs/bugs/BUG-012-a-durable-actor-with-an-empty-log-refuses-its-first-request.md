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

**Fix, to choose:** either an initial state (`AuthoritativeArgs<R, S> = { log,
initial?: S }`, two lines and the empty log becomes an ordinary case), or say in
the docs and in the type that a log begins with a record and give the vocabulary
a genesis record so every reader folds the same first line.  The second is the
larger promise and the better one if a durable actor is meant to be usable by
anyone with an empty file.

**Tests:** red first — spawn an authority on `logChannel([])`, send one
`ADD_RECORD` the spec allows, and expect `RECORD_ACCEPTED` with the fold holding
the record; today the process ends instead.
