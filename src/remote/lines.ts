// ── bytes on a stream, and the lines they carry ─────────────────────────────
//
// A line transport's reader, and the number that made it a file of its own: 13.3 MB of
// 87 KB frames read through `node:readline` costs 4.0 s on this box, and through a buffer
// and an `indexOf` it costs 76 ms.  The difference is not the parsing — it is that a
// frame the size of a file chunk is the normal case here and readline is built for the
// other one.
//
// Splitting on the byte 0x0a is safe for UTF-8: a continuation byte is never 0x0a, so a
// line boundary cannot fall inside a character, and a chunk boundary inside one is
// carried by the accumulator until the rest of it arrives.
//
// CRLF is read as a line ending rather than as part of the frame, which is what the line
// reader it replaces did; the frames this library writes end in "\n" alone.
//
// ── a line may carry octets after it ───────────────────────────────────────
//
// Not every frame on the wire is text: a chunk of a stream is a JSON head, the raw
// octets it announces, and a JSON tail.  So a line is also a question — how many octets
// follow — and the answer says where the next line starts.  `PartReader` is that state
// machine, over bytes as they arrive however the carrier splits them; a carrier that
// moves whole messages (a websocket) feeds it one message at a time and the machine
// cannot tell the difference.

import type { Readable } from "node:stream";

/** A reader, and the one way to stop it. */
export interface LineReader {
  /** Stop reading and drop what is buffered.  Idempotent. */
  stop(): void;
}

const NL = 0x0a;
const CR = 0x0d;

function withoutCr(line: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  return line.length > 0 && line[line.length - 1] === CR ? line.subarray(0, line.length - 1) : line;
}

/**
 * The wire as a sequence of lines, where a line may announce raw octets to follow it.
 *
 * `onLine` gets a line and answers how many octets come next — none, for every frame but
 * one that carries them.  Those octets reach `onBytes` whole, however many reads they
 * arrived in, and the reader goes back to looking for a newline.
 */
export class PartReader {
  private acc: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  /** How many octets the octet run still needs, or 0 while looking for a line. */
  private want = 0;
  private done = false;

  constructor(
    private readonly onLine: (line: string) => number | void,
    private readonly onBytes: (bytes: Uint8Array) => void,
  ) {}

  feed(chunk: Uint8Array): void {
    if (this.done) return;
    this.acc = this.acc.length === 0 ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : Buffer.concat([this.acc, chunk]);
    this.pump();
  }

  /** The stream is over: whatever is left of a line is still a line, as `readline` said. */
  end(): void {
    if (this.done) return;
    const rest = this.acc;
    this.acc = Buffer.alloc(0);
    this.done = true;
    if (rest.length > 0 && this.want === 0) this.onLine(withoutCr(rest).toString("utf8"));
  }

  private pump(): void {
    for (;;) {
      if (this.want > 0) {
        if (this.acc.length < this.want) return;
        const bytes = this.acc.subarray(0, this.want);
        this.acc = this.acc.subarray(this.want);
        this.want = 0;
        this.onBytes(bytes);
        continue;
      }
      const at = this.acc.indexOf(NL);
      if (at < 0) return;
      const line = this.acc.subarray(0, at);
      this.acc = this.acc.subarray(at + 1);
      const asked = this.onLine(withoutCr(line).toString("utf8"));
      if (typeof asked === "number") {
        // A run of no octets is still a run: the line said what follows, and it follows as nothing.
        if (asked > 0) this.want = asked;
        else this.onBytes(new Uint8Array(0));
      }
    }
  }
}

/**
 * Read `stream` as lines, with the octets a line announces.
 *
 * `onEnd` is called once when the stream is over, after the last line: a stream that
 * ends without its final newline still gives up its last line, because that is what the
 * peer meant to say.
 */
export function readParts(
  stream: Readable,
  onLine: (line: string) => number | void,
  onBytes: (bytes: Uint8Array) => void,
  onEnd?: () => void,
): LineReader {
  const reader = new PartReader(onLine, onBytes);
  return readChunks(
    stream,
    (chunk) => reader.feed(chunk),
    () => {
      reader.end();
      onEnd?.();
    },
  );
}

/** Read `stream` a line at a time, with no octets: the plain line carrier. */
export function readLines(stream: Readable, onLine: (line: string) => void, onEnd?: () => void): LineReader {
  return readParts(
    stream,
    (line) => {
      onLine(line);
    },
    () => {
      // A carrier that never announces octets never delivers any; a peer that sends them
      // anyway is talking past the protocol, and the bytes are dropped rather than guessed at.
    },
    onEnd,
  );
}

/** The bytes a stream carries, before anything is made of them. */
export function readChunks(stream: Readable, onChunk: (chunk: Uint8Array) => void, onEnd?: () => void): LineReader {
  let stopped = false;

  const onData = (chunk: Buffer | string): void => {
    if (stopped) return;
    onChunk(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  };

  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    stream.off("data", onData);
    onEnd?.();
  };

  stream.on("data", onData);
  // A pipe finishes in more than one way.  `end` is a peer that closes politely; one that vanishes —
  // a socket destroyed, a write that fails, a process killed — reports `close` or `error` and never
  // an end at all, and a reader that waits for the end alone hangs on a connection that is gone.
  stream.once("end", finish);
  stream.once("close", finish);
  stream.once("error", finish);

  return {
    stop(): void {
      stopped = true;
      stream.off("data", onData);
      stream.off("end", finish);
      stream.off("close", finish);
      stream.off("error", finish);
    },
  };
}
