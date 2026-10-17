# Streams

**Status:** drawn 2026-10-16 from the operator's spec, after the blob slice (`blob-references.md`) showed what
it could not do.  **Streams alone are built** (2026-10-17, slice 1 below): the transport carries octets beside its
lines, the store carries announcements, credit, chunks, done and fail, and a stream in an ordinary message body
crosses without the application doing anything.  Blobs and typed arrays are not on it yet, and the blob code still
in the tree runs its own wire: superseded, not yet removed.  Written first, because the wire is posipaki's business
and this changes the wire.

## The problem with a blob

A blob is a *value*: sized, whole, read as one.  That shape forced three things the seam cannot afford — the
reader assembles every byte before the caller sees any of it; nothing tells the writer to slow down (the whole
payload lands in the write stream's buffer); and a file that is being produced, or is bigger than memory, has
no way to cross at all.  10 MB measured 5.0 MB/s end to end, against 14 MB/s for the same frames through a
hand-written sink, and the pacer was the wire, not the reader's arithmetic.

A stream is what a file actually is on a connection: bytes arriving over time, asked for at the rate the reader
can take them.

## The shape

**At the process API three kinds of value may appear in a message; on the wire they all collapse to one: the
stream.**

- **A typed array** — `Uint8Array` and friends.  Materialised **at the boundary**: the sender's bytes become a
  stream as the frame is written, and the first chunk may ride along with the announcement.
- **A blob** — a lazy array.  Crosses as a stream over its bytes; the far side gets a **`RemoteBlob`**, whose
  `arrayBuffer()` and `stream()` are backed by that stream.  Nothing is read until it is asked for.
- **A stream** — a `Stream` here, a **`RemoteStream`** there.  The same object locally (a fork in this process
  is handed the stream itself), a reader over the wire when it crossed.

The library knows one thing: bytes moving.  Turning a stream into a `Uint8Array`, a `Blob` or a digest is the
platform's job (`new Response(stream).blob()`, `createHash().update(chunk)` per chunk) and one helper
(`bytesOf(stream)`) for the common case.

## The wire

Two kinds of thing travel.  Control frames are what they are today: one JSON object per line.  A **chunk** is a
segment: a JSON head, then raw bytes, then a JSON tail — announced by length and a cheap checksum, and carried
as bytes rather than base64 inside JSON.

```
{"$stream": {"id": 7, "size": 10485760, "type": "image/png", "name": "shot.png"}}\n   announcement
{"$msg": {"fromName": "a", "body": {"file": {"$s": {"id": 7}}}}}\n              the message that names it
{"$streamAsk": {"id": 7, "credit": 262144}}\n                                      the reader's demand, in bytes
{"$chunk": {"id": 7, "seq": 1, "bytes": 65536}}\n head: the length comes first, so framing does not scan
<65536 raw bytes>                                                               body
{"$chunkEnd": {"id": 7, "seq": 1, "crc32": 2663770700}}\n tail: the checksum, over the octets just written
{"$streamDone": {"id": 7}}\n    or    {"$streamFail": {"id": 7, "reason": "…"}}\n  the end of it
```

- **Order matters**: the announcement goes out before the message that references it, and for a typed array the
  first chunk may follow it immediately — so a reader that wants one chunk never waits a round trip for it.
- **Every chunk carries its length, and the checksum after it.**  The head says how many raw octets come next, so
  framing never scans; the tail carries the CRC-32 of those octets, so the reader hashes as they arrive and compares
  at the end.  **A wrong length is fatal to the connection** — the reader cannot find the next frame — while **a wrong
  checksum fails the stream** and leaves the connection alone.
- **Credit is the flow control, counted in bytes**: the reader grants a budget and the writer sends whole
  chunks until it is spent, carrying the remainder.  Chunk size is the framing unit, credit is the budget —
  nothing is written ahead of demand, so a slow reader slows the writer instead of filling a buffer.
- **A chunk names its stream**, so a chunk for an id nobody announced is rejected: the reader skips exactly the
  length the head announced and carries on, and the connection is untouched.  That is the reason the length is
  in the head at all — without it, rejection would mean guessing where the next frame starts.
- **Ids are the connection's own**, on the same parity split the process table uses, so an id says which side
  offered it.  A stream's id is alive from its announcement until `$streamDone`/`$streamFail`, or until the
  connection ends; an error anywhere drops it on both sides, and a reference to a dropped id is a named error.

## What a stream is in the API

An **async iterable of `Uint8Array`** is the core: no runtime dependency, no `node:stream`, no assumption that
a WHATWG `ReadableStream` exists.  `RemoteStream` is one; whoever wants the platform's own shape wraps it
(`ReadableStream` where there is one, `node:stream.Readable` where that is what the runtime offers) rather
than the library depending on either.  Backpressure is the credit above, so an iterable that is not pulled stops the wire.
A stream also carries `info` — the size, media type and name the offerer gave, when it gave any — so a caller can
ask what these bytes are before reading a byte of them.  It is a reading of the announcement, not a promise about
the count: the truth of `size` still arrives with the octets.

## What the transports owe

The segment needs bytes, and every transport used to be strings.  Built 2026-10-17: a transport is asked, per
line, how many raw octets follow it, hands them over whole, and carries on with lines — one state machine
(`PartReader` in `lines.ts`) over whatever the carrier delivers, so a fifo, a stdio pair and a unix socket feed it
bytes from the stream and a websocket feeds it one message at a time.  A websocket sends a line as a text message
and a run of octets as a binary one; the reader cannot tell the difference.  The channel one layer up gained
`sendSegment`/`onSegment` for the same reason, and the wrappers above a protocol pass them through
(`channelThrough`) so a wrapped connection does not quietly drop a stream.

## Order of work

Four slices, each tested before the next one starts, and every test at the **process level** — two real
processes over a fifo, a message in a body — because a fake substitutes exactly the layer that can be wrong:
the blob slice's 4.6 s/MB defect was invisible to twenty-eight handle cases and fifty-nine in-memory seam cases,
and one subprocess case found it in its first run.

1. **Streams, alone.**  The announcement, credit in bytes, a chunk as head/bytes/tail with its length and
   checksum, done and fail, the id table and its rejection rule; `RemoteStream` as an async iterable.  Tests:
   a stream read whole; a reader that pulls slowly (credit honoured, the writer never runs ahead); a consumer
   that stops early (both tables drop the id); a corrupt chunk (the stream fails, the connection survives); a
   chunk for an id nobody announced (rejected by skipping its announced length); a stream that ends in an error.
2. **Blobs on streams.**  `RemoteBlob` backed by a stream with `arrayBuffer()` and `stream()`; a local `Blob`
   offered without being read.  Tests: a blob round trip; a blob announced and never read (nothing crosses); a
   blob over the reader's bound, refused before a chunk is asked for.
3. **Typed arrays on blobs.**  Materialised at the boundary: the sender's array is handed over as chunks that
   are views over it, and the far side reads a blob.  Tests: bytes in a message body arrive readable; the array
   is not copied whole on the sending side.
4. **Performance, per primitive.**  Bytes per second through one wire for a raw pipe, a stream, a blob and a
   typed array, plus the overhead of each step over the one below it.  The numbers this replaces: the blob
   slice measured 5.0 MB/s against 14 MB/s for the same frames through a hand-written sink, and 185 MB/s for the
   raw pipe — with the wire, not the reader's arithmetic, as the pacer.

## What it does not do

- No seeking, no random access.  A stream is read once, forwards.
- No tee: one stream has one consumer.  A second reader is the application's problem (and a second announcement
  if it must be).
- No compression, no encryption, no integrity beyond the per-chunk checksum.
- No persistence: a stream lives as long as the side that offered it, and no longer than the connection.

## The checksum

CRC-32, named in the chunk head (`"crc32": "9f2c1a4b"`), computed by the runtime where it has one — `Bun.hash.crc32`
or `zlib.crc32`, the same IEEE polynomial, so either side verifies the other's — with a table implementation in
TypeScript as the fallback where neither exists.  Measured on this box (riscv64, bun 1.4.2, 64 KiB chunks, 16 MiB
runs): `Bun.hash.crc32` 615 MB/s, wyhash 531, xxHash64 523, `node:crypto` sha256 34, blake2b512 28, and a per-byte
TS table **1 MB/s** — this box has no JIT, so the loop runs interpreted here and would be hundreds of MB/s on x86.
Against the raw pipe's 185 MB/s the checksum costs a few per cent, which is what makes it affordable.  (Also
measured: `Bun.hash.xxHash3` takes the process down with a bus error on riscv64 — a bun defect, not ours.)

It catches accidents, not adversaries: random corruption, a truncated segment, chunks out of order.  Nothing here
defends against a party who can write the wire.

## Open

- **Chunk size**: 64 KiB today.  It bounds a single segment, so it decides the granularity at which a reader can
  stop — smaller means finer credit and more frames, larger means fewer frames and a longer wait for the first
  byte.
- **Whether the announcement may be omitted when the first chunk rides along** — it would save a frame per
  stream, and cost the reader the size/type facts it decides on.
- **Who reads the checksum's failure**: answered by the build, in the form the reader asked for — the stream's
  `read()` fails with the sentence, the connection is untouched, and the writer is told with `$streamFail`.
- **What a blob is now**: the blob slice's `BlobStore` and this store keep two tables on one connection.  The
  proposal has a blob become a stream with facts, which would leave one table; that is slice 2 and it has not been
  done, so today the two coexist.

## Supersedes

`blob-references.md`.  The value it describes, the reference and the lazy offer are all still right at the API
edge — a blob is a convenience over a stream — but the wire it describes (base64 in JSON, one ask, no credit)
is what this replaces.
