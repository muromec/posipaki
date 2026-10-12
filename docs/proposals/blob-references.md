# Blob References

**Status:** draft, 2026-10-11, from a design conversation with the operator about carrying files.  Nothing is
built.  Written here because the wire is posipaki's business; the first consumer is the harness, where a tool
server may run in another process or on another host and has to get at a file that lives with the message
archive.

## Motivation

A message between a process and its parent can already carry a process.  The frame writer walks it, every
process becomes `{$p: {id: 3, pname: 'target'}}`, and the far side gets a handle on that process rather than a
copy of it
(`src/remote/process-ref.ts`, applied to every frame by `encodeFrame`/`decodeFrame` in `src/remote/channel.ts`).

A file has no such value.  To move one today an application has to encode it itself: base64 in a message body,
with its own size limits, its own chunking when the file is large, and its own error handling when a transfer
dies halfway.  The harness is about to do exactly that — the tool server asks its parent for an attachment, the
parent reads the archive, and the bytes have to cross a fifo pair or an ssh wire back to the tool.  The encoding
belongs to the transport; an application that writes it down has to know which transport it is on.

## The shape

The same shape as a process reference, for bytes.

- A **blob** is a value a process can put in a message, carried as a reference:
  `{$b: {id: 7, size: 412345, mime: 'image/png', name: 'shot.png'}}`.  Everything in it is a value; the
  optional facts (`mime`, `name`, `sha256`) are simply absent when there is nothing to say.  They travel with
  the reference so a reader can decide before pulling anything.
- The side holding the bytes **offers** them to its connection:
  `connection.offerBlob({ size, mime, name, open })`.  `open` is what the connection calls when somebody reads,
  so a file nobody reads is never opened, encoded or copied.
- The far side gets a **handle**: `blob.size`, `blob.mime`, `blob.read()`.  The bytes come when they are asked
  for, not with the frame.
- `read()` is a request on the connection and an answer in chunks, so a 400 KB screenshot is not one frame and a
  400 MB file is refused by the reader before it starts rather than by the transport halfway through.
- Ids are the connection's own numbering, in a table beside the process one, with the same parity rule: both ends
  number their own and neither has to be guessed at.

What an application sees: bytes on one side, bytes on the other, and size and mime on the reference.  It never
sees base64.  Whether a frame carries base64, a hex field or a raw segment stays the serializer's business and
can change without a consumer noticing — which is the point of doing it at the wire instead of in the harness.

Ownership: the holder keeps the blob alive and drops it when it says so, and the connection drops it when the
connection ends.  Reading a blob that is gone is a named error, the way a call on a dead process is.

## Copying, moving, sharing

A browser hands bytes to a worker three ways, and the same three belong here, because what a read costs should
follow the connection rather than the application:

- **moved** — both ends are in one address space (the harness's `inline` environment, a forked actor in the same
  process): the read hands the buffer over and detaches the sender's view, the way a transfer list does with an
  `ArrayBuffer`.  No copy, and the sender cannot use it afterwards — which is the right rule here anyway, since
  the harness's copy is scratch.
- **shared** — two processes on one host (the `isolated` environment, a sandbox with the mapping bound in): one
  region mapped by both, so a read costs a pointer and the owner keeps it alive for as long as the blob is
  offered.  A file in `/dev/shm`, or an anonymous mapping whose descriptor travels with the frame.
- **copied** — the wire is all there is between the two ends (`ssh`, a container, a websocket): the frames carry
  the bytes, chunked, and base64 is a detail inside them.

The application sees the same thing in all three: a handle whose `read()` gives bytes.  What differs is what the
read costs, and that is a fact about the connection — the handshake that already tells both ends which protocol
they speak is where they can say they share memory, so an offer can be served the cheap way without the caller
asking for it.

Two consequences worth writing down now: a transfer that detaches the sender's buffer has no lifetime question on
that side (the blob is spent), while a shared read has one (who unmaps, and when).  And a mode that is only an
optimisation must never be the reason a read fails: a mapping that cannot be made falls back to the copy, and the
caller hears nothing about it.

## The data frame

The ways to move bytes are the platform's, and base64 is only the tax a text transport charges:

- **one address space** — nothing to do: the value travels in the frame as an object, which is what happens
  today between a parent and its forked child.
- **shared memory** — two ends on one host: one mapping, and a read costs a pointer.  No transfer at all.
- **a binary transport** — a websocket's binary frames, a unix socket: the bytes go as they are.
- **a line transport** — a fifo pair or stdio, where a frame is a line: the frame declares the bytes it carries
  and the bytes follow it, so the framing is length-prefixed rather than base64.  A line that has to stay
  text-only makes base64 the transport's own choice, invisible above it.

So a blob's bytes are a stream on the connection rather than a field in a JSON body: the reference `{$b}` names
the blob, the read opens the stream, and the frames that follow belong to it — keyed by the stream the way `$fd`
frames are keyed by a descriptor.

One constraint, found while writing this: the existing byte frames are **text**.  `fdWriter` sends
`String(chunk)` (`src/remote/streams.ts`), which is right for a process's own stdout and loses bytes for anything
else.  A stream that carries a file has to be binary-safe — either the frame grows a bytes field that is not
stringified, or the length-prefixed form above is what it uses.

## What it does not do

- No filesystem semantics: no paths, no seeking, no partial reads.  A reader gets the bytes or an error.
- No caching policy.  Whether the same bytes are offered twice is the application's question; `sha256` is carried
  so a reader *can* dedupe, not so the wire does.
- Not general RPC: a blob is read, not called.
- No standing storage.  A blob lives as long as the side that offered it; persistence belongs to whoever offered
  it — the harness's archive, in the first consumer.

## Open

- Chunk size and length prefix, and whether a reader may stream a blob rather than await it whole.
- Whether `open` can also push — the holder telling the connection a blob is ready.  The first consumer does not
  need it: it answers a question.
- Whether the reference carries `sha256` at all, or only size and mime.
- Whether a blob reference may be forwarded: a process handing on what it was given.

## The first consumer, for scale

The harness's attachments.  A transport hands the harness bytes, the archive keeps them, and a tool server in an
environment asks its parent for one by attachment id.  The answer is a message carrying a blob reference —
`{$b: {id, size: 412345, mime: 'image/png', name: 'shot.png'}}` — that the tool server reads into its own scratch
directory, or that the connector reads into an image part for the model.  The attachment id stays the harness's
own fact; the connection's blob id is nobody else's business.
