# Streams

**Status:** drawn 2026-10-16 from the operator's spec, after the blob slice (`blob-references.md`) showed what
it could not do.  **Streams, blobs and typed arrays are built** (2026-10-17): the transport carries octets beside
its lines, the store carries announcements, credit, chunks, done and fail, and a stream, a blob or a typed array in
an ordinary message body crosses without the application doing anything.  The announcement says only that octets
are coming: what they are, and the facts about them, ride the reference (corrected 2026-10-17, before any of this
was published).  The blob wire this replaces is gone: `BlobStore`, its base64 frames and its second table are
deleted, and one store per connection carries all three.  Written first, because the wire is posipaki's business
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
stream — and the value that references it says which of the three it was.**

- **A typed array** — `Uint8Array` and friends.  Materialised **at the boundary**: the sender's bytes become a
  stream as the frame is written, and the far side gets a **`RemoteBytes`** sized from the reference and filled as
  the chunks land.  It is the one value that is not lazy: the reference arriving is the demand.
- **A blob** — a lazy array.  Crosses as a stream over its bytes; the far side gets a **`RemoteBlob`**, whose
  `size`, `type` and `name` come from the reference and whose `arrayBuffer()` and `stream()` are backed by that
  stream.  Nothing is read until it is asked for.
- **A stream** — a `Stream` here, a **`RemoteStream`** there.  The same object locally (a fork in this process
  is handed the stream itself), a reader over the wire when it crossed.  It carries no facts about its contents.

The library knows one thing: bytes moving.  Turning a stream into a `Uint8Array`, a `Blob` or a digest is the
platform's job (`new Response(stream).blob()`, `createHash().update(chunk)` per chunk) and one helper
(`bytesOf(stream)`) for the common case.

## The wire

Two kinds of thing travel.  Control frames are what they are today: one JSON object per line.  A **chunk** is a
segment: a JSON head, then raw bytes, then a JSON tail — announced by length and a cheap checksum, and carried
as bytes rather than base64 inside JSON.

```
{"$stream": {"id": 7}}\n                                                            octets are coming
{"$msg": {"fromName": "a", "body": {"file": {"$s": {"id": 7}}}}}\n                  a stream
{"$msg": {"fromName": "a", "body": {"data": {"$bytes": {"id": 7, "size": 4}}}}}\n   a typed array
{"$msg": {"fromName": "a", "body": {"shot": {"$blob": {"id": 7, "size": 4, "type": "image/png", "name": "shot.png"}}}}}\n
{"$streamAsk": {"id": 7, "credit": 262144}}\n                                      the reader's demand, in bytes
{"$chunk": {"id": 7, "seq": 1, "bytes": 65536}}\n head: the length comes first, so framing does not scan
<65536 raw bytes>                                                               body
{"$chunkEnd": {"id": 7, "seq": 1, "crc32": 2663770700}}\n tail: the checksum, over the octets just written
{"$streamDone": {"id": 7}}\n    or    {"$streamFail": {"id": 7, "reason": "…"}}\n  the end of it
```

- **The announcement carries the id and nothing else.**  It says octets are coming; what they are is the
  reference's to say, and the facts a reader decides on — a blob's size, an array's length — arrive with it,
  before a chunk is asked for.
- **Order matters**: the announcement goes out before the message that references it, so a reference is always
  decodable.
- **Every chunk carries its length, and the checksum after it.**  The head says how many raw octets come next, so
  framing never scans; the tail carries the CRC-32 of those octets, so the reader hashes as they arrive and compares
  at the end.  **A wrong length is fatal to the connection** — the reader cannot find the next frame — while **a wrong
  checksum fails the stream** and leaves the connection alone.
- **Credit is the flow control, counted in bytes**: the reader grants a budget and the writer sends whole
  chunks until it is spent, carrying the remainder.  Chunk size is the framing unit, credit is the budget —
  nothing is written ahead of demand, so a slow reader slows the writer instead of filling a buffer.  A typed
  array is the exception in when it asks, not in whether it is paced: the ask goes out on delivery, and credit
  still bounds what can be in flight.
- **The bound splits by what the reference states.**  An array and a blob can be refused before a chunk is asked
  for; a stream states no length, so its bound is counted as octets land and it is failed when it passes.
- **A chunk names its stream**, so a chunk for an id nobody announced is rejected: the reader skips exactly the
  length the head announced and carries on, and the connection is untouched.  That is the reason the length is
  in the head at all — without it, rejection would mean guessing where the next frame starts.
- **Ids are the connection's own**, and one space serves everything numbered on it: the process table and the
  stream store draw from the same counter on the same parity split, so a number names one thing and its parity says
  which side made it.  A stream's id is alive from its announcement until `$streamDone`/`$streamFail`, or until the
  connection ends; an error anywhere drops it on both sides, and a reference to a dropped id is a named error.

## What a stream is in the API

An **async iterable of `Uint8Array`** is the core: no runtime dependency, no `node:stream`.  `RemoteStream` is one,
and it also answers the platform's own surface — `getReader()`, `pipeTo()`, `tee()` — built over the same queue
the first time it is asked for, so code written for a `ReadableStream` can take what arrives and the reader and
the iterable share one lock.  A runtime with no `ReadableStream` keeps the iterable as the whole interface.
Backpressure is the credit above, so a stream nobody pulls stops the wire.

**A stream carries no facts about its contents.**  A stream from a file does not know the file's name, and a
`ReadableStream` has no length to report, so `size`, `type` and `name` are not the stream's to carry.  They belong
to the value that references it, which is also where the receiver learns what it was given: `{"$s": {"id"}}` is a
stream, `{"$bytes": {"id", "size"}}` an array, `{"$blob": {"id", "size", "type", "name"}}` a file.

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
2. **Blobs on streams.**  Built: `RemoteBlob` over the stream an offer becomes, with `arrayBuffer()` and
   `stream()`; `isBlob` recognises a platform `Blob` or `File` and offers it by its slices, so nothing of it is
   read until somebody reads it; `BlobStore` and its frames are deleted.  Tests: a blob round trip carrying its
   facts; a blob announced and never read (no octet on the wire, no read of the source); a blob handed on without
   being read here; a blob over the reader's bound, refused before a chunk is asked for.
3. **Typed arrays.**  Built, and the one value that is not lazy: the bytes are already here, so the reference
   arriving *is* the demand.  The far side asks at once, sizes a buffer from the stated length and fills it as the
   chunks land, so awaiting the `RemoteBytes` waits for the last chunk rather than for a read to start.  It is a
   thenable rather than an array because an array answers `length` and `[i]` synchronously and bytes in flight
   cannot; `arrayBuffer()` gives the platform's shape.

4. **Performance, per primitive.**  Measured 2026-10-17, 10 MiB over one fifo between two processes, 64 KiB
   chunks, this box (riscv64, bun 1.4.2): **stream 13.0 MB/s, typed array 9.4, blob 8.5**, against **185 MB/s**
   for raw octets through the same pipe (measured 2026-10-16, same hardware).  The stream is the fastest of the
   three because nothing puts it back together: the far side hashes each chunk as it arrives, where a blob is
   assembled (one 10 MiB copy) and a typed array is written into a buffer sized from its reference.  The medium is
   not the pacer: the
   same frames through a hand-written sink measured 35–40 MB/s in the blob slice.  No lever was pulled; the
   candidates are named in the blob slice's notes (base64 is gone from chunks, so what is left is one JSON head
   and one JSON tail per 64 KiB).

## What it does not do

- No seeking, no random access.  A stream is read once, forwards.
- No `slice()` on a received blob.  The platform's `Blob` has one and the wire has no byte range, so a sliced view
  could only be served by reading from the start and discarding; `RemoteBlob` is a Blob in everything but that.
- No tee: one stream has one consumer.  A second reader is the application's problem (and a second announcement
  if it must be).
- No compression, no encryption, no integrity beyond the per-chunk checksum.
- No persistence: a stream lives as long as the side that offered it, and no longer than the connection.
- No names, and only one direction.  A stream is referenced by an id its offerer minted, so only that side knows the
  number, and the bytes go one way.  `stream-names.md` proposes a pipe with both directions and a name, and where
  the fd layer goes once a stream can be found.

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
- **A byte range on the ask**, which would let a received blob answer `slice()` and let a reader skip ahead: the ask
  would carry an offset and the writer discard what is below it, or the source seek.  Not built — today a blob is
  readable whole, and only whole.
- **Who reads the checksum's failure**: answered by the build, in the form the reader asked for — the stream's
  `read()` fails with the sentence, the connection is untouched, and the writer is told with `$streamFail`.

## Supersedes

`blob-references.md`.  The value it describes, the reference and the lazy offer are all still right at the API
edge — a blob is a convenience over a stream — but the wire it describes (base64 in JSON, one ask, no credit)
is what this replaces.

**What this removed.**  `src/remote/blob.ts`, `BlobStore`, `BlobHandle`, the `$b`/`$blobAsk`/`$blobData` frames and
the second table a connection used to keep.  A blob and a typed array are now two shapes of *reference* over the
same store — `{"$blob": {"id", "size", "type", "name"}}` and `{"$bytes": {"id", "size"}}` — and the announcement
behind them says only that octets are coming.  Anything that imported the old names breaks: that is deliberate, and
it is why this is one change rather than two wires kept alive beside each other.
