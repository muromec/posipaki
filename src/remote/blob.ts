// ── blobs on the wire ──────────────────────────────────────────────────────
//
// A process crosses a connection as a reference (`$p`, process-ref.ts); so does a file
// (`$b`).  The reference says how big the bytes are and, optionally, what they are and
// what they are called; the bytes stay where they are until somebody asks, because a copy
// nobody reads is bandwidth spent on a guess.
//
//   {"$b": {"id": 7, "size": 412345, "mime": "image/png", "name": "shot.png"}}  the value
//   {"$blobAsk": {"id": 7, "seq": 1}}              somebody wants it: the ask
//   {"$blobData": {"seq": 1, "data": "…"}}         one chunk, base64 (this wire is text)
//   {"$blobEnd": {"seq": 1, "bytes": 412345}}      the last of it, and how much it was
//   {"$blobFail": {"seq": 1, "reason": "…"}}       it cannot be had, and why
//
// The base64 is this protocol's tax, not the shape's: an application hands over a
// Uint8Array and gets one back, and the framing can learn to carry bytes whole — a binary
// transport, a length-prefixed line — without the application hearing about it.
//
// Ownership: the side that offers a blob keeps it (`release` drops one, and the store drops
// all of them when its connection closes).  An id is that side's, allocated once per offer
// and never reused; the two sides number from different parities, as the process table
// does, so an id says whose it is as well as what it names.
//
// A read is one ask and an answer in chunks, so a 400 KB screenshot is not one frame and a
// 400 MB file is refused by the reader before it starts rather than by the transport
// halfway through.  What a read costs belongs to the connection, not to the application:
// this module moves bytes, and a cheaper way to move them is a change here.

import type { Channel } from "./channel.js";
import { rootIdFor, type IdParity } from "./process-ref.js";

/** The key that marks a blob reference inside an otherwise JSON value. */
export const BLOB_REF = "$b";

/** Bytes per data frame.  64 KiB of raw bytes is ~87 KiB of base64: one line that a line
 *  transport takes whole, small enough that a slow reader does not hold a whole file. */
export const DEFAULT_CHUNK_BYTES = 64 * 1024;

/** What a reader will accept without being asked.  A file bigger than this is a decision
 *  somebody makes on purpose (`maxBytes`), not something a wire should decide silently. */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** What a blob says about itself: everything a reader needs to decide before pulling. */
export interface BlobFacts {
  size: number;
  mime?: string;
  name?: string;
  sha256?: string;
}

/** The value a blob crosses as.  All of it is JSON, and the optional facts are simply
 *  absent when there is nothing to say. */
export interface BlobRef extends BlobFacts {
  id: number;
}

/** What a side holds to be able to answer: the facts, and the way to the bytes.  `open` is
 *  called when somebody reads, so a blob nobody reads is never opened, encoded or copied. */
export interface BlobOffer extends BlobFacts {
  open(): Uint8Array | Promise<Uint8Array>;
}

/** One ask: this connection's `id`, and the `seq` the answer will name. */
export interface BlobAsk {
  id: number;
  seq: number;
}

export interface BlobData {
  seq: number;
  data: string;
}

export interface BlobEnd {
  seq: number;
  bytes: number;
}

export interface BlobFail {
  seq: number;
  reason: string;
}

/** The reference a value carries, or null when it is not one.  Judged by shape, not by
 *  `instanceof`, the way a process reference is: a build can hold two copies of a type. */
export function asBlobRef(value: unknown): BlobRef | null {
  if (typeof value !== "object" || value === null) return null;
  const body = (value as Record<string, unknown>)[BLOB_REF];
  if (typeof body !== "object" || body === null) return null;
  const { id, size, mime, name, sha256 } = body as Record<string, unknown>;
  if (typeof id !== "number" || typeof size !== "number") return null;
  const ref: BlobRef = { id, size };
  if (typeof mime === "string") ref.mime = mime;
  if (typeof name === "string") ref.name = name;
  if (typeof sha256 === "string") ref.sha256 = sha256;
  return ref;
}

/** A reference as it crosses: the value form of a blob this side holds. */
export function blobRefOf(id: number, facts: BlobFacts): BlobRef {
  const ref: BlobRef = { id, size: facts.size };
  if (facts.mime !== undefined) ref.mime = facts.mime;
  if (facts.name !== undefined) ref.name = facts.name;
  if (facts.sha256 !== undefined) ref.sha256 = facts.sha256;
  return ref;
}

/** The wire form of a reference, which is what an application puts in a message. */
export function blobValue(ref: BlobRef): Record<string, unknown> {
  return { [BLOB_REF]: { ...ref } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The ask a frame carries, or null.  A malformed one is not worth an answer: nobody to
 *  answer to, since the seq is what an answer names. */
export function asBlobAsk(frame: Record<string, unknown>): BlobAsk | null {
  const body = frame.$blobAsk;
  if (!isObject(body)) return null;
  const { id, seq } = body;
  return typeof id === "number" && typeof seq === "number" ? { id, seq } : null;
}

export function blobDataOf(frame: Record<string, unknown>): BlobData | null {
  const body = frame.$blobData;
  if (!isObject(body)) return null;
  const { seq, data } = body;
  return typeof seq === "number" && typeof data === "string" ? { seq, data } : null;
}

export function blobEndOf(frame: Record<string, unknown>): BlobEnd | null {
  const body = frame.$blobEnd;
  if (!isObject(body)) return null;
  const { seq, bytes } = body;
  return typeof seq === "number" && typeof bytes === "number" ? { seq, bytes } : null;
}

export function blobFailOf(frame: Record<string, unknown>): BlobFail | null {
  const body = frame.$blobFail;
  if (!isObject(body)) return null;
  const { seq, reason } = body;
  return typeof seq === "number" && typeof reason === "string" ? { seq, reason } : null;
}

/** One read in flight: the chunks so far, and what settles it. */
interface Read {
  chunks: string[];
  bytes: number;
  expected: number;
  id: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
}

/** A handle on a blob the far side holds: the facts now, the bytes when asked. */
export class BlobHandle {
  readonly id: number;
  readonly size: number;
  readonly mime: string | undefined;
  readonly name: string | undefined;
  readonly sha256: string | undefined;
  private readonly store: BlobStore;

  constructor(store: BlobStore, ref: BlobRef) {
    this.store = store;
    this.id = ref.id;
    this.size = ref.size;
    this.mime = ref.mime;
    this.name = ref.name;
    this.sha256 = ref.sha256;
  }

  /** The bytes, as they are on the side that offered them.  Refused here, by name, when the
   *  reference already says the blob is over this side's limit — no ask goes out for a file
   *  nobody is going to take. */
  read(): Promise<Uint8Array> {
    return this.store.read(this);
  }
}

export interface BlobStoreOptions {
  chunkBytes?: number;
  maxBytes?: number;
}

/**
 * One connection's blobs, as this side sees them.
 *
 * Both directions live here, because both are the same table: what this side offers (and
 * answers asks for) and what it may read from the far side (the handles it was handed).
 * Ids are this side's own numbering — the parity rule of the process table, one step at a
 * time — so an id names one blob on one connection and nothing anywhere else.
 */
export class BlobStore {
  private readonly channel: Channel;
  private readonly chunkBytes: number;
  readonly maxBytes: number;
  /** What this side holds, by its own ids. */
  private readonly pvtOffers = new Map<number, BlobOffer>();
  private readonly pvtIds = new Map<BlobOffer, number>();
  /** The next id this side may hand out, in its own parity. */
  private pvtNext: number;
  /** Reads this side asked for, by the seq the answer will name. */
  private readonly pvtReads = new Map<number, Read>();
  private pvtSeq = 0;
  private readonly pvtOff: () => void;

  constructor(channel: Channel, parity: IdParity, options: BlobStoreOptions = {}) {
    this.channel = channel;
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.pvtNext = rootIdFor(parity);
    this.pvtOff = channel.onMessage((frame) => {
      void this.onFrame(frame);
    });
  }

  /** Offer bytes to the connection: the reference now, the read whenever somebody asks.
   *  Offering the same offer twice is one blob, numbered once. */
  offer(offer: BlobOffer): BlobRef {
    const known = this.pvtIds.get(offer);
    if (known !== undefined) return blobRefOf(known, offer);
    const id = this.pvtNext;
    this.pvtNext += 2;
    this.pvtOffers.set(id, offer);
    this.pvtIds.set(offer, id);
    return blobRefOf(id, offer);
  }

  /** A handle on a blob the far side offered, from the reference as it arrived.  Null when
   *  the value is not a reference at all: a message that carries no file is not an error. */
  handle(value: unknown): BlobHandle | null {
    const ref = asBlobRef(value);
    return ref === null ? null : new BlobHandle(this, ref);
  }

  /** Drop a blob this side holds.  A read that arrives afterwards is refused by name. */
  release(id: number): boolean {
    const offer = this.pvtOffers.get(id);
    if (offer === undefined) return false;
    this.pvtOffers.delete(id);
    this.pvtIds.delete(offer);
    return true;
  }

  /** The ids this side is holding, in the order they were offered. */
  held(): number[] {
    return [...this.pvtOffers.keys()];
  }

  /** Stop answering, and refuse every read still in flight: the connection is not there to
   *  carry an answer, so a promise left waiting would wait for the life of the process. */
  close(): void {
    this.pvtOff();
    const reason = new Error("the connection closed before the blob arrived");
    for (const read of this.pvtReads.values()) read.reject(reason);
    this.pvtReads.clear();
    this.pvtOffers.clear();
    this.pvtIds.clear();
  }

  /** One read: the ask, then whatever the answer turns out to be. */
  async read(handle: BlobHandle): Promise<Uint8Array> {
    if (handle.size > this.maxBytes) {
      throw new Error(
        `blob ${handle.id} is ${handle.size} bytes, over this side's ${this.maxBytes}-byte limit`,
      );
    }
    const seq = ++this.pvtSeq;
    const bytes = new Promise<Uint8Array>((resolve, reject) => {
      this.pvtReads.set(seq, { id: handle.id, chunks: [], bytes: 0, expected: handle.size, resolve, reject });
    });
    try {
      await this.channel.send({ $blobAsk: { id: handle.id, seq } });
    } catch (err) {
      this.pvtReads.delete(seq);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return bytes;
  }

  /** A frame from the far side: an ask to answer, or part of an answer to collect. */
  private async onFrame(frame: Record<string, unknown>): Promise<void> {
    const ask = asBlobAsk(frame);
    if (ask !== null) return this.serve(ask);

    const data = blobDataOf(frame);
    if (data !== null) {
      const read = this.pvtReads.get(data.seq);
      if (read !== undefined) {
        read.chunks.push(data.data);
        read.bytes += Buffer.from(data.data, "base64").byteLength;
      }
      return;
    }

    const end = blobEndOf(frame);
    if (end !== null) {
      const read = this.pvtReads.get(end.seq);
      if (read === undefined) return;
      this.pvtReads.delete(end.seq);
      const bytes = new Uint8Array(Buffer.concat(read.chunks.map((chunk) => Buffer.from(chunk, "base64"))));
      // Two ways the answer can be wrong, and both are worth a sentence: the stream ended
      // early, or at a length the reference did not promise.
      if (bytes.byteLength !== end.bytes) {
        read.reject(
          new Error(`blob ${end.seq} ended at ${bytes.byteLength} bytes, its last frame said ${end.bytes}`),
        );
        return;
      }
      if (bytes.byteLength !== read.expected) {
        read.reject(
          new Error(`blob ${read.id} ended at ${bytes.byteLength} bytes, its reference said ${read.expected}`),
        );
        return;
      }
      read.resolve(bytes);
      return;
    }

    const fail = blobFailOf(frame);
    if (fail !== null) {
      const read = this.pvtReads.get(fail.seq);
      if (read === undefined) return;
      this.pvtReads.delete(fail.seq);
      read.reject(new Error(fail.reason));
    }
  }

  /** Answer an ask: the chunks, then the count — or one sentence saying why not. */
  private async serve(ask: BlobAsk): Promise<void> {
    const offer = this.pvtOffers.get(ask.id);
    if (offer === undefined) return this.fail(ask.seq, `no such blob: ${ask.id}`);

    let bytes: Uint8Array;
    try {
      bytes = await offer.open();
    } catch (err) {
      return this.fail(ask.seq, `blob ${ask.id} could not be read: ${errorText(err)}`);
    }
    // The reference is a promise to whoever decides whether to pull; bytes that disagree
    // with it are not sent, because the reader would only find out after paying for them.
    if (bytes.byteLength !== offer.size) {
      return this.fail(ask.seq, `blob ${ask.id} is ${bytes.byteLength} bytes, its reference said ${offer.size}`);
    }
    for (let at = 0; at < bytes.byteLength; at += this.chunkBytes) {
      const chunk = bytes.subarray(at, Math.min(at + this.chunkBytes, bytes.byteLength));
      await this.channel.send({
        $blobData: { seq: ask.seq, data: Buffer.from(chunk).toString("base64") },
      });
    }
    await this.channel.send({ $blobEnd: { seq: ask.seq, bytes: bytes.byteLength } });
  }

  private fail(seq: number, reason: string): Promise<void> {
    return Promise.resolve(this.channel.send({ $blobFail: { seq, reason } })).then(() => undefined);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
