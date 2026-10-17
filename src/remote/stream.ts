// ── streams on the wire ────────────────────────────────────────────────────
//
// A stream is bytes arriving over time.  A blob has to be whole before anybody can look at it,
// so the reader waits for all of it, the writer has nothing to slow it down, and a file bigger
// than memory cannot cross at all.  A stream is what a file already is on a connection: asked
// for at the rate the reader can take it.
//
//   {"$stream": {"id": 7, "size": 10485760, "type": "image/png"}}   announced first
//   {"$msg": {"fromName": "a", "body": {"file": {"$s": {"id": 7}}}}}  the message that names it
//   {"$streamAsk": {"id": 7, "credit": 262144}}                      the reader's demand, in bytes
//   {"$chunk": {"id": 7, "seq": 1, "bytes": 65536}}                  a chunk: its head…
//   <65536 raw octets>                                              …its bytes…
//   {"$chunkEnd": {"id": 7, "seq": 1, "crc32": 2663770700}}         …and the checksum, after them
//   {"$streamDone": {"id": 7}}                                       or {"$streamFail": {…, "reason": …}}
//   {"$streamCancel": {"id": 7}}                                     a reader that stops early
//
// The announcement goes out before the frame that references it, so a reader never receives a
// reference to something it has not been told about.  The head's `bytes` is what keeps the
// framing: a reader that does not know the stream still skips exactly that many octets, and a
// head whose length is a lie is the one thing that costs the connection rather than the stream.
//
// Credit is the flow control, counted in bytes: the reader grants a window and the writer sends
// whole chunks until it is spent.  Nothing is written ahead of demand, so a slow consumer slows
// the writer instead of filling a buffer somewhere.

import { isPlainObject, isStreamLike, type Channel, type ValueCodec } from "./channel.js";

export { isStreamLike };
import { rootIdFor, type IdParity } from "./process-ref.js";

/** The chunk size, which bounds one segment. */
export const DEFAULT_CHUNK_BYTES = 64 * 1024;

/** How far ahead of the consumer a writer may run: the credit window, in bytes. */
export const DEFAULT_WINDOW_BYTES = 4 * DEFAULT_CHUNK_BYTES;

/** The largest stream this side will take: a reader that will not read a 5 GB file should say so
 *  before the first chunk, not after the last. */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** What a stream may know about itself before any of it has been read. */
export interface StreamInfo {
  /** Bytes in total, when the offerer knows. */
  readonly size?: number;
  /** The media type, when the offerer knows. */
  readonly type?: string;
  /** A name for a file, when the stream came from one. */
  readonly name?: string;
}

/** A stream of octets: what the library takes at one end of a connection and gives at the other. */
export interface Stream extends AsyncIterable<Uint8Array> {
  /** What the offerer said about these bytes — total size, media type, a name — when it said anything. */
  readonly info?: StreamInfo;
}

/** What a message carries in place of a stream: the id this side announced. */
export interface StreamRef {
  $s: { id: number };
}

export function isStreamRef(value: unknown): value is StreamRef {
  if (typeof value !== "object" || value === null) return false;
  const body = (value as { $s?: unknown }).$s;
  if (typeof body !== "object" || body === null) return false;
  return typeof (body as { id?: unknown }).id === "number";
}


// ── the checksum ───────────────────────────────────────────────────────────
//
// CRC-32, because it is the one the runtime already has: `Bun.hash.crc32` costs 0.1 ms for a
// 64 KiB chunk here and a table written in TypeScript costs 65 ms on a box without a JIT.  The
// numbers are in docs/proposals/streams.md; the polynomial is the same everywhere, so either
// side verifies the other's.

type Crc = (bytes: Uint8Array) => number;

let pvtCrc: Crc | null = null;

function crcOf(): Crc {
  if (pvtCrc !== null) return pvtCrc;
  const bun = (globalThis as { Bun?: { hash?: { crc32?: (data: Uint8Array) => number } } }).Bun;
  if (typeof bun?.hash?.crc32 === "function") {
    const native = bun.hash.crc32;
    pvtCrc = (bytes) => native(bytes) >>> 0;
    return pvtCrc;
  }
  // Node 22 has it on `zlib`, reachable without importing anything the browser cannot parse.
  const builtin = (globalThis as { process?: { getBuiltinModule?: (name: string) => unknown } }).process
    ?.getBuiltinModule?.("node:zlib") as { crc32?: (data: Uint8Array) => number } | undefined;
  if (typeof builtin?.crc32 === "function") {
    const native = builtin.crc32;
    pvtCrc = (bytes) => native(bytes) >>> 0;
    return pvtCrc;
  }
  pvtCrc = tableCrc;
  return pvtCrc;
}

/** CRC-32 by hand, for a runtime that has none.  Correct, and slow where nothing is a JIT. */
function tableCrc(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ pvtTable[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

const pvtTable: number[] = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    table.push(value >>> 0);
  }
  return table;
})();

/** The checksum a chunk's tail carries. */
export function crc32(bytes: Uint8Array): number {
  return crcOf()(bytes);
}

// ── the reader's side ──────────────────────────────────────────────────────

/** What a stream on this side costs and asks for, without knowing the connection. */
interface ReaderHooks {
  /** Octets taken by the consumer: credit spent, and the writer may be asked for more. */
  consumed(bytes: number): void;
  /** The consumer will take no more. */
  cancelled(reason: string): void;
}

/**
 * Bytes the far side offers, read at the consumer's pace.
 *
 * An async iterable of octets, and nothing more: turning it into an array, a `Blob` or a digest
 * is the platform's job — `new Response(stream).arrayBuffer()` where there is a `Response`,
 * `for await` where there is not.
 */
export class RemoteStream implements Stream {
  private readonly queue: Uint8Array[] = [];
  private readonly waiting: Array<{ resolve: (r: IteratorResult<Uint8Array>) => void; reject: (e: Error) => void }> =
    [];
  private ended = false;
  private failure: Error | null = null;
  private stopped = false;

  constructor(
    private readonly hooks: ReaderHooks,
    readonly info: StreamInfo = {},
  ) {}

  /** The far side sent more of it. */
  push(bytes: Uint8Array): void {
    if (this.ended || this.failure || this.stopped) return;
    const waiting = this.waiting.shift();
    if (!waiting) {
      this.queue.push(bytes);
      return;
    }
    this.hooks.consumed(bytes.length);
    waiting.resolve({ value: bytes, done: false });
  }

  /** The far side has sent all of it. */
  end(): void {
    if (this.ended || this.failure) return;
    this.ended = true;
    for (const waiting of this.waiting.splice(0)) waiting.resolve({ value: undefined, done: true });
  }

  /** The far side gave up on it, or it arrived corrupt. */
  fail(reason: string): void {
    if (this.ended || this.failure) return;
    this.failure = new Error(reason);
    for (const waiting of this.waiting.splice(0)) waiting.reject(this.failure);
  }

  /** Take no more of it.  Said to the far side, so it stops reading its source. */
  cancel(reason = "the reader stopped"): void {
    if (this.stopped || this.ended) return;
    this.stopped = true;
    this.queue.length = 0;
    for (const waiting of this.waiting.splice(0)) waiting.resolve({ value: undefined, done: true });
    this.hooks.cancelled(reason);
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    const queued = this.queue.shift();
    if (queued) {
      this.hooks.consumed(queued.length);
      return { value: queued, done: false };
    }
    if (this.failure) throw this.failure;
    if (this.ended || this.stopped) return { value: undefined, done: true };
    return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }

  async return(): Promise<IteratorResult<Uint8Array>> {
    this.cancel();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this;
  }
}

// ── the store ──────────────────────────────────────────────────────────────

/** What this side is sending: the source, the credit it has been given, and what is left of a chunk. */
interface Offered {
  id: number;
  source: AsyncIterator<Uint8Array>;
  info: StreamInfo;
  /** The rest of a piece the source gave us, not yet cut into chunks. */
  pending: Uint8Array | null;
  /** Octets the reader has asked for and not been sent. */
  credit: number;
  seq: number;
  pumping: boolean;
  dropped: boolean;
}

/** What this side is reading. */
interface Incoming {
  id: number;
  reader: RemoteStream;
  /** Octets asked for, and octets the consumer has taken: what may still be in flight. */
  asked: number;
  consumed: number;
  /** The chunk whose head and bytes have arrived, waiting for its tail. */
  chunk: { seq: number; bytes: Uint8Array } | null;
  done: boolean;
}

export interface StreamStoreOptions {
  chunkBytes?: number;
  windowBytes?: number;
  maxBytes?: number;
}

/**
 * One connection's streams, as this side sees them.
 *
 * Both directions are in one table, because both are the same numbering: what this side offers
 * (and answers asks for) and what it may read from the far side.  Ids follow the process table's
 * parity, so an id names one stream on one connection and nothing anywhere else.
 */
export class StreamStore implements ValueCodec {
  private readonly channel: Channel;
  private readonly chunkBytes: number;
  private readonly windowBytes: number;
  readonly maxBytes: number;
  private readonly pvtOffers = new Map<number, Offered>();
  private readonly pvtIncoming = new Map<number, Incoming>();
  private pvtNext: number;
  /** Why streams that are over failed, for a reference that arrives after the fact. */
  private readonly pvtRefused = new Map<number, string>();
  private readonly pvtOff: () => void;
  private readonly pvtSegmentOff: (() => void) | null = null;
  private pvtClosed = false;

  constructor(channel: Channel, parity: IdParity, options: StreamStoreOptions = {}) {
    this.channel = channel;
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.pvtNext = rootIdFor(parity);
    this.pvtOff = channel.onMessage((frame) => {
      this.onFrame(frame);
    });
    this.pvtSegmentOff = channel.onSegment?.((head, bytes) => this.onSegment(head, bytes)) ?? null;
  }

  /** Whether this connection can carry a stream at all: it must carry octets beside its lines. */
  get canCarryStreams(): boolean {
    return this.pvtSegmentOff !== null && this.channel.sendSegment !== undefined;
  }

  /**
   * Offer a stream to the connection: the announcement goes out now, and the bytes when the far
   * side asks for them.  What comes back is what a message carries in its place.
   */
  offer(stream: Stream, info: StreamInfo = {}): StreamRef {
    const id = this.pvtNext;
    this.pvtNext += 2;
    const offered: Offered = {
      id,
      source: stream[Symbol.asyncIterator](),
      info,
      pending: null,
      credit: 0,
      seq: 0,
      pumping: false,
      dropped: false,
    };
    this.pvtOffers.set(id, offered);
    void this.channel.send({ $stream: { id, ...info } });
    return { $s: { id } };
  }

  /** A value on its way out: every stream in it becomes an announcement and a reference. */
  encode(value: unknown): unknown {
    return this.pvtEncode(value, new Set());
  }

  /** A value just read: every reference in it becomes something this side can read. */
  decode(value: unknown): unknown {
    return this.pvtDecode(value, new Set());
  }

  /** Drop every stream of this connection, in both directions.  Called when it ends. */
  close(): void {
    if (this.pvtClosed) return;
    this.pvtClosed = true;
    this.pvtOff();
    this.pvtSegmentOff?.();
    for (const offered of this.pvtOffers.values()) {
      offered.dropped = true;
      void offered.source.return?.();
    }
    this.pvtOffers.clear();
    for (const incoming of this.pvtIncoming.values()) incoming.reader.fail("the connection ended");
    this.pvtIncoming.clear();
  }

  /** The ids this side is holding, in the order they were offered. */
  held(): number[] {
    return [...this.pvtOffers.keys()];
  }

  // ── writing ────────────────────────────────────────────────────────────

  private pvtSend(frame: Record<string, unknown>): Promise<void> {
    return Promise.resolve(this.channel.send(frame));
  }

  private pvtEncode(value: unknown, seen: Set<unknown>): unknown {
    if (typeof value !== "object" || value === null) return value;
    // Offering reads the source's own facts (`size`, `type`, `name`), so it is asked before the
    // walk decides the value is a plain object to copy.
    if (isStreamLike(value)) return this.offer(value, factsOf(value));
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => this.pvtEncode(item, seen));
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    // Only a plain object is walked into: a handle, a logger, anything with its own prototype is
    // the application's and is left as it is.  Copying one would take its methods away.
    if (!isPlainObject(value)) return value;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = this.pvtEncode(item, seen);
    return copy;
  }

  private pvtTake(offered: Offered): Uint8Array | null {
    if (offered.pending === null) return null;
    const size = Math.min(offered.pending.length, this.chunkBytes, offered.credit);
    const piece = offered.pending.subarray(0, size);
    offered.pending = size === offered.pending.length ? null : offered.pending.subarray(size);
    return piece;
  }

  private async pvtPull(offered: Offered): Promise<boolean> {
    const next = await offered.source.next();
    if (next.done) return false;
    const value: unknown = next.value;
    const bytes =
      value instanceof Uint8Array
        ? value
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : null;
    if (bytes === null) throw new TypeError("a stream may only yield octets");
    if (bytes.length === 0) return true;
    offered.pending = bytes;
    return true;
  }

  private async pvtPump(offered: Offered): Promise<void> {
    if (offered.pumping || offered.dropped || this.pvtClosed) return;
    offered.pumping = true;
    try {
      while (!offered.dropped && offered.credit > 0) {
        if (offered.pending === null && !(await this.pvtPull(offered))) {
          await this.channel.send({ $streamDone: { id: offered.id } });
          this.pvtDrop(offered);
          return;
        }
        const piece = this.pvtTake(offered);
        if (piece === null) continue;
        const seq = offered.seq;
        offered.seq += 1;
        offered.credit -= piece.length;
        await this.channel.sendSegment?.({ $chunk: { id: offered.id, seq, bytes: piece.length } }, piece);
        await this.channel.send({ $chunkEnd: { id: offered.id, seq, crc32: crc32(piece) } });
      }
    } catch (error) {
      await this.pvtSend({ $streamFail: { id: offered.id, reason: reasonOf(error) } }).catch(() => {});
      this.pvtDrop(offered);
    } finally {
      offered.pumping = false;
    }
  }

  private pvtDrop(offered: Offered): void {
    if (offered.dropped) return;
    offered.dropped = true;
    this.pvtOffers.delete(offered.id);
  }

  /**
   * Take a stream out of the live table and remember why it ended, for a reference that arrives
   * after the fact: "no stream was announced" is the wrong sentence for a stream that was refused.
   */
  private pvtRetire(id: number, reason: string): void {
    this.pvtIncoming.delete(id);
    this.pvtRefused.set(id, reason);
    // A connection lives a long time and a refusal is rare; past a bound the oldest reason goes.
    if (this.pvtRefused.size > 64) {
      const oldest = this.pvtRefused.keys().next();
      if (!oldest.done) this.pvtRefused.delete(oldest.value);
    }
  }

  // ── reading ────────────────────────────────────────────────────────────

  private pvtDecode(value: unknown, seen: Set<unknown>): unknown {
    if (typeof value !== "object" || value === null) return value;
    if (isStreamRef(value)) return this.pvtReaderFor(value.$s.id);
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => this.pvtDecode(item, seen));
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    // Whatever a store earlier in the chain already turned into a handle is not a plain object any
    // more, and copying it here would strip what makes it one.
    if (!isPlainObject(value)) return value;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = this.pvtDecode(item, seen);
    return copy;
  }

  private pvtReaderFor(id: number): RemoteStream {
    const incoming = this.pvtIncoming.get(id);
    if (incoming) return incoming.reader;
    // A reference to a stream that is over, or one this side was never told about.  The reader says
    // so when it is read rather than throwing in the middle of a decoded frame: it was the message's
    // fault, not the connection's.
    const reason = this.pvtRefused.get(id) ?? `no stream was announced with id ${id}`;
    const failed = new RemoteStream({ consumed() {}, cancelled() {} });
    failed.fail(reason);
    return failed;
  }

  private pvtAsk(incoming: Incoming): void {
    if (incoming.done || this.pvtClosed) return;
    const outstanding = incoming.asked - incoming.consumed;
    if (outstanding >= this.windowBytes / 2) return;
    const credit = this.windowBytes - outstanding;
    incoming.asked += credit;
    void this.channel.send({ $streamAsk: { id: incoming.id, credit } });
  }

  private pvtAnnounced(id: number, info: StreamInfo): void {
    const existing = this.pvtIncoming.get(id);
    existing?.reader.fail(`a stream was announced twice with id ${id}`);
    // The reader is built before the record it lives in: its callbacks close over that record and only run
    // once a chunk or a cancel arrives, which is after the assignment below.
    let incoming: Incoming;
    const reader = new RemoteStream(
      {
        consumed: (bytes) => {
          incoming.consumed += bytes;
          this.pvtAsk(incoming);
        },
        cancelled: (reason) => {
          incoming.done = true;
          this.pvtIncoming.delete(id);
          void this.channel.send({ $streamCancel: { id, reason } });
        },
      },
      info,
    );
    incoming = { id, reader, asked: 0, consumed: 0, chunk: null, done: false };
    this.pvtIncoming.set(id, incoming);
    // Refuse before a chunk is asked for: a stream this side will not read is a sentence now.
    if (info.size !== undefined && info.size > this.maxBytes) {
      incoming.done = true;
      reader.fail(`stream ${id} is ${info.size} bytes, over this side's bound of ${this.maxBytes}`);
      void this.channel.send({ $streamFail: { id, reason: "over the reader's bound" } });
      this.pvtRetire(id, `stream ${id} is ${info.size} bytes, over this side's bound of ${this.maxBytes}`);
      return;
    }
    this.pvtAsk(incoming);
  }

  private onSegment(head: Record<string, unknown>, bytes: Uint8Array): void {
    const chunk = head.$chunk as { id?: unknown; seq?: unknown; bytes?: unknown } | undefined;
    if (typeof chunk?.id !== "number" || typeof chunk.seq !== "number") return;
    const incoming = this.pvtIncoming.get(chunk.id);
    if (!incoming || incoming.done) {
      // A stream this side has dropped or never heard of: the octets are skipped, and that is what
      // the announced length is for.
      return;
    }
    incoming.chunk = { seq: chunk.seq, bytes };
  }

  private onFrame(frame: Record<string, unknown>): void {
    if (this.pvtClosed) return;
    if ("$stream" in frame) {
      const body = frame.$stream as { id?: unknown; size?: unknown; type?: unknown; name?: unknown } | undefined;
      if (typeof body?.id !== "number") return;
      this.pvtAnnounced(body.id, {
        size: typeof body.size === "number" ? body.size : undefined,
        type: typeof body.type === "string" ? body.type : undefined,
        name: typeof body.name === "string" ? body.name : undefined,
      });
      return;
    }
    if ("$streamAsk" in frame) {
      const body = frame.$streamAsk as { id?: unknown; credit?: unknown } | undefined;
      const offered = typeof body?.id === "number" ? this.pvtOffers.get(body.id) : undefined;
      if (!offered || typeof body?.credit !== "number" || body.credit <= 0) return;
      offered.credit += body.credit;
      void this.pvtPump(offered);
      return;
    }
    if ("$chunkEnd" in frame) {
      const body = frame.$chunkEnd as { id?: unknown; seq?: unknown; crc32?: unknown } | undefined;
      const incoming = typeof body?.id === "number" ? this.pvtIncoming.get(body.id) : undefined;
      if (!incoming) return;
      const chunk = incoming.chunk;
      incoming.chunk = null;
      if (chunk === null || chunk.seq !== body?.seq) {
        incoming.done = true;
        incoming.reader.fail(`stream ${incoming.id} lost its framing: a chunk ended that never began`);
        this.pvtRetire(incoming.id, `stream ${incoming.id} lost its framing: a chunk ended that never began`);
        void this.channel.send({ $streamFail: { id: incoming.id, reason: "lost the framing" } });
        return;
      }
      if (typeof body?.crc32 === "number" && crc32(chunk.bytes) !== body.crc32) {
        incoming.done = true;
        incoming.reader.fail(`stream ${incoming.id} arrived corrupt: chunk ${chunk.seq} failed its checksum`);
        this.pvtRetire(incoming.id, `stream ${incoming.id} arrived corrupt: chunk ${chunk.seq} failed its checksum`);
        void this.channel.send({ $streamFail: { id: incoming.id, reason: "a chunk failed its checksum" } });
        return;
      }
      incoming.reader.push(chunk.bytes);
      return;
    }
    if ("$streamDone" in frame) {
      const body = frame.$streamDone as { id?: unknown } | undefined;
      const incoming = typeof body?.id === "number" ? this.pvtIncoming.get(body.id) : undefined;
      if (!incoming) return;
      incoming.done = true;
      this.pvtIncoming.delete(incoming.id);
      incoming.reader.end();
      return;
    }
    if ("$streamFail" in frame) {
      const body = frame.$streamFail as { id?: unknown; reason?: unknown } | undefined;
      const incoming = typeof body?.id === "number" ? this.pvtIncoming.get(body.id) : undefined;
      if (!incoming) return;
      const reason = typeof body?.reason === "string" ? body.reason : `stream ${incoming.id} failed`;
      incoming.done = true;
      incoming.reader.fail(reason);
      this.pvtRetire(incoming.id, reason);
      return;
    }
    if ("$streamCancel" in frame) {
      const body = frame.$streamCancel as { id?: unknown } | undefined;
      const offered = typeof body?.id === "number" ? this.pvtOffers.get(body.id) : undefined;
      if (!offered) return;
      this.pvtDrop(offered);
      void offered.source.return?.();
    }
  }
}

/** What a stream says about itself before any of it is read, when it knows. */
function factsOf(stream: Stream): StreamInfo {
  const facts = stream as { size?: unknown; type?: unknown; name?: unknown };
  const info: { size?: number; type?: string; name?: string } = {};
  if (typeof facts.size === "number") info.size = facts.size;
  if (typeof facts.type === "string") info.type = facts.type;
  if (typeof facts.name === "string") info.name = facts.name;
  return info;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
