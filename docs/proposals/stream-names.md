# Streams are pipes, and they can be named

**Status: proposed 2026-10-17, not built.**  Streams, blobs and typed arrays are built (`streams.md`), one-way, each
referenced by an id its announcing side minted.  Two things are wrong with that as a primitive: a stream is a pipe
and both ends may talk on it, and a stream nobody can name is a stream nobody else can find.

**Duplex is deferred** (operator, 2026-10-17): streams stay one-way for now, so the naming half below is what gets
built and the pipe section is what duplex would take when it comes.  A one-way stream still needs a name for the fd
layer to go.

## A stream is a pipe

The built stream carries bytes one way: the announcer writes, the referrer reads.  That came from the platform's
`ReadableStream`, and it is not what a pipe is — the fd layer in the tree already models one fd with two directions
(`FdStream { read, write }` in `streams.ts`), which is the same contradiction in another file.

So the announcement opens a pipe.  Either side writes into it, either side reads what the other wrote, and the two
directions are independent in credit, in numbering and in ending.

```
{"$stream": {"id": 7, "name": "stderr"}}      open a pipe; the name is optional
{"$chunk": {"id": 7, "seq": 0, "bytes": 65536}}   … raw octets …   {"$chunkEnd": {"id": 7, "seq": 0, "crc32": …}}
{"$streamAsk": {"id": 7, "credit": 262144}}   a reader's demand, for the other side's direction
{"$streamEof": {"id": 7}}                     I will write no more
{"$streamCancel": {"id": 7}}                  I will read no more
{"$streamFail": {"id": 7, "reason": "…"}}     broken: both directions dead
```

A side that has sent `$streamEof` still reads; a side that has sent `$streamCancel` still writes.  Each frame closes
one direction and nothing else, so neither is a close of the pipe.

**Close is derived, not announced.**  The pipe is gone when each side has closed its direction — EOF or cancel — or
on `$streamFail`, or when the connection ends.  Both ends can compute that from what they have seen, so no frame
carries it; the id and the name are released at that moment.

Chunk sequence numbers are per direction: A's `seq` counts A's chunks, so the two directions never contend for one
counter.

`RemoteStream` gains the missing half — a writer beside `getReader()` — and a blob or a typed array is a one-way
*use* of the same pipe, since nobody writes the other direction.  No flag distinguishes them.

## A name is how a stream is found

An id is minted by the announcing side, so only that side knows it: enough for a value that travels once, not enough
for a pipe somebody has to find again.  A name rides the announcement, and a reference may carry it instead of the id.

```
{"$stream": {"id": 7, "name": "stderr"}}
{"$msg": {"body": {"log": {"$s": {"name": "stderr"}}}}}     resolved on the side that received the announcement
{"$msg": {"body": {"log": {"$s": {"id": 7}}}}}              or by id, as today
```

The map is a pair, like the ids: names this side announced, and names the far side did.  A reference by name
resolves in the second.

- **The announcement is the declaration.**  An unknown name fails the way an unknown id does, with the name in the
  sentence.
- **One name per connection.**  A second announcement of a live name is refused, and the refusal is an answer on the
  wire rather than a silent replacement.
- **EOF does not release the name.**  The pipe is still open in the other direction; the close releases it, which
  is what makes the name announceable again.
- No rename, no name added after the announcement, no names across connections.

## Where the fds go

An fd is a named pipe, and the name denotes the pipe rather than a direction, so both sides are peers on it.

| fd | name | directions |
|---|---|---|
| 1 | `stdout` | the process holder writes, the other side reads |
| 2 | `stderr` | the same, for its errors |
| 0 | `stdin`  | the other side writes, the process holder reads |

`{"$fd": n, "data": "…"}` stops existing, and with it `fdWriter`, the three separate readers of output frames
(`withOutput`, `nextFrame`, `connectionFds`), the `String(chunk)` decode that mangles a character split across two
writes, and the `JSON.stringify` of a payload that was not a string.  A sink (`stderrSink`, `logStream`) stays: it
is what a caller does with the bytes, not how they arrive.

## What it does not do

- No rename, no access control, no names across connections.
- No seeking, no tee — unchanged from `streams.md`.
- The two directions share one id and one name and nothing else, including no ordering between them.

## Open

- **How a caller waits for a name**: `named(name)` answering `undefined` until it is announced is the smallest;
  `onNamed(name, handler)` returning an unsubscribe is what a process's `stderr` wants, since it appears when the
  process starts rather than when the reader asks.
- **Who may announce a name**: the side that owns the fd (the process holder) is the natural answer for `stdout`
  and `stderr`, and the feeder for `stdin`.  Nothing in the wire enforces it; the rule would be a convention of
  whoever wires the fds.
- **A writer that ignores credit** is a protocol error today, and a pipe makes a slow reader likelier; whether to
  fail the stream or the connection is unchanged by this proposal and worth settling with it.

## Order of work

1. **Duplex.**  The second direction in the store, per-direction credit and `seq`, `$streamEof` and `$streamCancel`
   per direction, close derived.  Tests: both directions in flight at once; one side EOFs and the other keeps
   writing; the pipe closes only when both have closed; a cancel leaves the other direction alive.
2. **Names.**  The name on the announcement, the pair of maps, a reference by name, a duplicate refused, the name
   released at close.  Tests: a reference by name after the announcement; an unknown name; a duplicate refused; the
   name announceable again after a close.
3. **Finding it.**  `named()` and whichever waiting shape the Open section decides.
4. **The fds on top**, deleting `$fd` and its four helpers and rewiring the gateway, whose payload output is the
   only producer today.
