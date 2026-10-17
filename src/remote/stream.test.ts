// ── streams ────────────────────────────────────────────────────────────────
//
// Two stores on one wire, driven by hand: the shape of a connection without the connection, for
// the things a stream has to be right about whatever the medium is doing — order, credit, a
// reader that stops, a chunk that arrives corrupt.  What must hold on a real pipe as well gets
// its own case beside this file.

import { describe, expect, it } from "vitest";

import type { Channel } from "./channel.js";
import { StreamStore, crc32, isStreamRef, type Stream, type StreamStoreOptions } from "./stream.js";

/** One end of a fake wire: what it writes appears at the other end, in order, a tick later. */
class FakeChannel implements Channel {
  peer: FakeChannel | null = null;
  readonly frames: Record<string, unknown>[] = [];
  readonly segments: Array<{ head: Record<string, unknown>; bytes: Uint8Array }> = [];
  private frameReaders = new Set<(frame: Record<string, unknown>) => void>();
  private segmentReaders = new Set<(head: Record<string, unknown>, bytes: Uint8Array) => void>();
  private queue: Array<() => void> = [];
  private scheduled = false;

  send(frame: Record<string, unknown>): void {
    this.frames.push(frame);
    this.enqueue(() => {
      for (const reader of this.peer!.frameReaders) reader(frame);
    });
  }

  sendSegment(head: Record<string, unknown>, bytes: Uint8Array): void {
    this.segments.push({ head, bytes });
    this.enqueue(() => {
      for (const reader of this.peer!.segmentReaders) reader(head, bytes);
    });
  }

  onMessage(handler: (frame: Record<string, unknown>) => void): () => void {
    this.frameReaders.add(handler);
    return () => this.frameReaders.delete(handler);
  }

  onSegment(handler: (head: Record<string, unknown>, bytes: Uint8Array) => void): () => void {
    this.segmentReaders.add(handler);
    return () => this.segmentReaders.delete(handler);
  }

  onClose(): void {
    // nothing: these cases end a connection by closing its stores
  }

  async close(): Promise<void> {
    // same
  }

  /** Octets this end has written as segments, however many frames carried them. */
  sentOctets(): number {
    return this.segments.reduce((total, segment) => total + segment.bytes.length, 0);
  }

  /** A frame the far side would have sent, delivered to this end directly. */
  deliver(frame: Record<string, unknown>): void {
    this.enqueue(() => {
      for (const reader of this.frameReaders) reader(frame);
    });
  }

  /** Octets the far side would have sent, after a head it announced. */
  deliverSegment(head: Record<string, unknown>, bytes: Uint8Array): void {
    this.enqueue(() => {
      for (const reader of this.segmentReaders) reader(head, bytes);
    });
  }

  private enqueue(fn: () => void): void {
    this.queue.push(fn);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      while (this.queue.length > 0) this.queue.shift()!();
    });
  }
}

interface Wire {
  a: FakeChannel;
  b: FakeChannel;
  aStore: StreamStore;
  bStore: StreamStore;
}

function wire(options: { a?: StreamStoreOptions; b?: StreamStoreOptions } = {}): Wire {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  return { a, b, aStore: new StreamStore(a, "odd", options.a), bStore: new StreamStore(b, "even", options.b) };
}

/** A stream of `count` chunks of `size` octets, each filled with its index. */
function counted(count: number, size: number): Stream & { first: number; pulled: number } {
  const self = {
    first: 0,
    pulled: 0,
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      for (let index = 1; index <= count; index += 1) {
        if (self.first === 0) self.first = index;
        self.pulled += 1;
        yield new Uint8Array(size).fill(index);
      }
    },
  };
  return self as Stream & { first: number; pulled: number };
}

/** The chunks a reader gives up, in order. */
async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/** A tick of the fake wire: what one side wrote has reached the other. */
const settle = (): Promise<void> => new Promise((done) => setImmediate(done));

/** Hand the far side what a message would have carried, and get back what it can read.  The
 *  announcement is written before the message, so it is delivered before it too. */
async function handOver(from: StreamStore, to: StreamStore, value: unknown): Promise<{ ref: unknown; file: Stream }> {
  const reference = from.encode({ file: value }) as { file: unknown };
  await settle();
  return { ref: reference.file, file: (to.decode({ file: reference.file }) as { file: Stream }).file };
}

describe("a stream on the wire", () => {
  it("goes out as an announcement and a reference, and arrives as something to read", async () => {
    const { a, aStore, bStore } = wire();
    const source = counted(3, 4);

    const { ref, file } = await handOver(aStore, bStore, source);
    // The announcement is written before anything names it, and what a message carries is a reference.
    expect(a.frames[0]).toMatchObject({ $stream: { id: 1 } });
    expect(isStreamRef(ref)).toBe(true);

    const chunks = await readAll(file);
    expect(chunks.map((chunk) => chunk[0])).toEqual([1, 2, 3]);
    expect(source.pulled).toBe(3);
    // Read to the end, the writer has let it go.
    await settle();
    expect(aStore.held()).toEqual([]);
    aStore.close();
    bStore.close();
  });

  it("says what the stream is, when the stream knows", async () => {
    const { aStore, bStore } = wire();
    const source = Object.assign(counted(1, 4), { size: 4, type: "image/png", name: "shot.png" });
    const { file } = await handOver(aStore, bStore, source);
    expect(file.info).toEqual({ size: 4, type: "image/png", name: "shot.png" });
    aStore.close();
    bStore.close();
  });

  it("never runs further ahead than the reader has asked for", async () => {
    const chunkBytes = 8;
    const windowBytes = 24;
    const { a, aStore, bStore } = wire({ b: { chunkBytes, windowBytes }, a: { chunkBytes } });
    const source = counted(20, chunkBytes);

    const { file } = await handOver(bStore, aStore, source);

    // Take the stream a chunk at a time, slowly enough that a writer which ignored the credit
    // would have pushed all twenty chunks long before the last one was asked for.
    const taken: Uint8Array[] = [];
    for await (const chunk of file) {
      taken.push(chunk);
      await settle();
      expect(a.sentOctets() - taken.length * chunkBytes).toBeLessThanOrEqual(windowBytes);
    }

    expect(taken).toHaveLength(20);
    expect(source.pulled).toBe(20);
    aStore.close();
    bStore.close();
  });

  it("stops the far side when the reader stops", async () => {
    const { b, aStore, bStore } = wire({ a: { chunkBytes: 4 }, b: { windowBytes: 24 } });
    const source = counted(100, 4);

    const { file } = await handOver(aStore, bStore, source);
    for await (const chunk of file) {
      expect(chunk.length).toBe(4);
      break;
    }

    await settle();
    // The writer is told, drops the stream, and stops pulling its source.
    expect(b.frames.some((frame) => "$streamCancel" in frame)).toBe(true);
    expect(aStore.held()).toEqual([]);
    expect(source.pulled).toBeLessThan(100);
    aStore.close();
    bStore.close();
  });

  it("fails the stream on a corrupt chunk and leaves the connection alone", async () => {
    const { a, b, aStore, bStore } = wire();
    void a;

    b.deliver({ $stream: { id: 1, size: 4 } });
    await settle();
    const reader = bStore.decode({ file: { $s: { id: 1 } } }) as { file: Stream };

    const bytes = new Uint8Array([1, 2, 3, 4]);
    b.deliverSegment({ $chunk: { id: 1, seq: 0, bytes: 4 } }, bytes);
    b.deliver({ $chunkEnd: { id: 1, seq: 0, crc32: crc32(bytes) ^ 0xff } });

    await expect(readAll(reader.file)).rejects.toThrow(/checksum/);
    // The connection goes on: the fault was said out loud to the far side.
    await settle();
    expect(b.frames.some((frame) => "$streamFail" in frame)).toBe(true);
    aStore.close();
    bStore.close();
  });

  it("skips the octets of a chunk nobody announced", async () => {
    const { a, b, aStore, bStore } = wire();
    void a;

    const bytes = new Uint8Array([9, 9, 9, 9]);
    // A chunk for a stream this side was never told about: its octets are skipped, by the length
    // the head announced, and nothing else about the connection changes.
    b.deliverSegment({ $chunk: { id: 41, seq: 0, bytes: 4 } }, bytes);
    b.deliver({ $chunkEnd: { id: 41, seq: 0, crc32: crc32(bytes) } });
    b.deliver({ $stream: { id: 1, size: 4 } });
    await settle();

    const reader = bStore.decode({ file: { $s: { id: 1 } } }) as { file: Stream };
    b.deliverSegment({ $chunk: { id: 1, seq: 0, bytes: 4 } }, bytes);
    b.deliver({ $chunkEnd: { id: 1, seq: 0, crc32: crc32(bytes) } });
    b.deliver({ $streamDone: { id: 1 } });

    expect((await readAll(reader.file)).map((chunk) => chunk[0])).toEqual([9]);
    aStore.close();
    bStore.close();
  });

  it("fails the stream when the far side says it failed", async () => {
    const { aStore, bStore, b } = wire();
    b.deliver({ $stream: { id: 1 } });
    await settle();
    const reader = bStore.decode({ file: { $s: { id: 1 } } }) as { file: Stream };
    b.deliver({ $streamFail: { id: 1, reason: "the disk went away" } });

    await expect(readAll(reader.file)).rejects.toThrow(/disk went away/);
    aStore.close();
    bStore.close();
  });

  it("tells a reference to a stream it never heard of", async () => {
    const { aStore, bStore } = wire();
    const reader = bStore.decode({ file: { $s: { id: 7 } } }) as { file: Stream };
    await expect(readAll(reader.file)).rejects.toThrow(/no stream was announced with id 7/);
    aStore.close();
    bStore.close();
  });

  it("refuses a stream past its bound before asking for a chunk", async () => {
    const { a, b, aStore, bStore } = wire({ b: { maxBytes: 8 } });
    // 32 octets and it says so: the reader can refuse without reading a byte.
    const source = Object.assign(counted(4, 8), { size: 32 });
    const { file } = await handOver(aStore, bStore, source);

    await expect(readAll(file)).rejects.toThrow(/over this side's bound of 8/);
    await settle();
    expect(b.frames.some((frame) => "$streamAsk" in frame)).toBe(false);
    expect(a.segments).toHaveLength(0);
    aStore.close();
    bStore.close();
  });

  it("fails the stream when its source throws, and says why", async () => {
    const { a, aStore, bStore } = wire({ a: { chunkBytes: 4 } });
    const source: Stream = {
      async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        yield new Uint8Array(4).fill(1);
        throw new Error("the disk went away");
      },
    };
    const { file } = await handOver(aStore, bStore, source);

    await expect(readAll(file)).rejects.toThrow(/disk went away/);
    await settle();
    expect(a.frames.some((frame) => "$streamFail" in frame)).toBe(true);
    aStore.close();
    bStore.close();
  });
});
