// ── streams ────────────────────────────────────────────────────────────────
//
// Two stores on one wire, driven by hand: the shape of a connection without the connection, for
// the things a stream has to be right about whatever the medium is doing — order, credit, a
// reader that stops, a chunk that arrives corrupt.  What must hold on a real pipe as well gets
// its own case beside this file.

import { describe, expect, it } from "vitest";

import type { Channel } from "./channel.js";
import {
  RemoteBlob,
  RemoteStream,
  RemoteBytes,
  StreamStore,
  crc32,
  isStreamRef,
  type BlobSource,
  type Stream,
  type StreamStoreOptions,
} from "./stream.js";

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
async function handOver(from: StreamStore, to: StreamStore, value: unknown): Promise<{ ref: unknown; file: RemoteStream }> {
  const reference = from.encode({ file: value }) as { file: unknown };
  await settle();
  return { ref: reference.file, file: (to.decode({ file: reference.file }) as { file: RemoteStream }).file };
}

describe("a stream on the wire", () => {
  it("goes out as an announcement and a reference, and arrives as something to read", async () => {
    const { a, aStore, bStore } = wire();
    const source = counted(3, 4);

    const { ref, file } = await handOver(aStore, bStore, source);
    // The announcement is written before anything names it, and what a message carries is a reference.
    // Ids come from the connection's space, two past this side's root: the odd side's first is 3.
    expect(a.frames[0]).toMatchObject({ $stream: { id: 3 } });
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

  it("keeps the facts on the reference, not on the stream", async () => {
    const { a, aStore, bStore } = wire();
    // A stream knows nothing about what it carries: a source that happens to have `size`, `type` and
    // `name` on it does not make the announcement any richer.
    const source = Object.assign(counted(1, 4), { size: 4, type: "image/png", name: "shot.png" });

    const { ref } = await handOver(aStore, bStore, source);
    expect(a.frames[0]).toEqual({ $stream: { id: 3 } });
    expect(ref).toEqual({ $s: { id: 3 } });
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

  it("counts a stream past its bound as it arrives, and fails it there", async () => {
    const { a, b, aStore, bStore } = wire({ b: { maxBytes: 8, windowBytes: 8 } });
    // A stream states no length, so the reader cannot refuse it up front: it counts the octets as
    // they land and stops as soon as they pass the bound.
    const source = counted(4, 8);
    const { file } = await handOver(aStore, bStore, source);

    await expect(readAll(file)).rejects.toThrow(/passed this side's bound of 8 bytes/);
    await settle();
    // It did ask — a stream has to be read to be measured — and then told the far side to stop.
    expect(b.frames.some((frame) => "$streamAsk" in frame)).toBe(true);
    expect(b.frames.some((frame) => "$streamFail" in frame)).toBe(true);
    expect(a.sentOctets()).toBeLessThanOrEqual(16);
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

  it("answers the platform's reader, so code written for a ReadableStream can take it", async () => {
    const { aStore, bStore } = wire({ a: { chunkBytes: 4 } });
    const { file } = await handOver(aStore, bStore, counted(3, 4));
    const stream = file;

    const reader = stream.getReader();
    // A second reader while one is held is the platform's refusal, not a second consumer.
    expect(() => stream.getReader()).toThrow();
    const first = await reader.read();
    expect([...(first.value as Uint8Array)]).toEqual([1, 1, 1, 1]);
    const second = await reader.read();
    expect((second.value as Uint8Array)[0]).toBe(2);
    const third = await reader.read();
    expect(third.value?.[0]).toBe(3);
    const end = await reader.read();
    expect(end.done).toBe(true);
    reader.releaseLock();
    aStore.close();
    bStore.close();
  });

  it("pipes into a sink, and the caller writes no loop", async () => {
    const { aStore, bStore } = wire({ a: { chunkBytes: 4 } });
    const { file } = await handOver(aStore, bStore, counted(3, 4));
    const taken: number[] = [];
    const sink = new WritableStream<Uint8Array>({
      write: (chunk) => {
        taken.push(chunk[0]);
      },
    });

    await file.pipeTo(sink);
    expect(taken).toEqual([1, 2, 3]);
    aStore.close();
    bStore.close();
  });
});

/** A blob the way a platform hands one over: sized, and read a window at a time.  `reads` counts
 *  what was actually read, so "nothing was read" is a number rather than an argument. */
function fileOf(bytes: Uint8Array, facts: { type?: string; name?: string } = {}) {
  const reads = { count: 0 };
  const window = (start: number, end: number): BlobSource => {
    const part = bytes.subarray(start, end);
    return {
      size: part.length,
      slice: (from = 0, to = part.length) => window(start + from, start + Math.min(to, part.length)),
      arrayBuffer: async () => {
        reads.count += 1;
        return part.slice().buffer as ArrayBuffer;
      },
    };
  };
  return {
    size: bytes.length,
    ...facts,
    reads,
    slice: (start = 0, end = bytes.length) => window(start, end),
    arrayBuffer: async () => {
      reads.count += 1;
      return bytes.slice().buffer as ArrayBuffer;
    },
  };
}

/** The same hand-over, for a value that comes back as a blob. */
async function handOverBlob(from: StreamStore, to: StreamStore, value: unknown): Promise<RemoteBlob> {
  const reference = from.encode({ file: value }) as { file: unknown };
  await settle();
  const decoded = to.decode({ file: reference.file }) as { file: unknown };
  expect(decoded.file).toBeInstanceOf(RemoteBlob);
  return decoded.file as RemoteBlob;
}

describe("a blob on the wire", () => {
  it("crosses as a stream of its octets and arrives as a blob with its facts", async () => {
    const { aStore, bStore } = wire();
    const source = fileOf(new Uint8Array([1, 2, 3, 4, 5, 6]), { type: "image/png", name: "shot.png" });

    const file = await handOverBlob(aStore, bStore, source);

    expect(file.size).toBe(6);
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("shot.png");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
    aStore.close();
    bStore.close();
  });

  it("reads nothing of it until somebody reads it", async () => {
    const { a, b, aStore, bStore } = wire();
    const source = fileOf(new Uint8Array([7, 7, 7, 7]), { type: "text/plain" });

    const file = await handOverBlob(aStore, bStore, source);
    await settle();

    // Announced, and that is all: no ask went out, so no octet did either.
    expect(source.reads.count).toBe(0);
    expect(a.sentOctets()).toBe(0);
    expect(b.segments).toEqual([]);

    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([7, 7, 7, 7]);
    expect(source.reads.count).toBeGreaterThan(0);
    aStore.close();
    bStore.close();
  });

  it("can be handed on without being read here", async () => {
    const { aStore, bStore } = wire();
    const source = fileOf(new Uint8Array([9, 8, 7]));
    const first = await handOverBlob(aStore, bStore, source);

    // Back the other way with the value that arrived, not with the one that was sent.
    const reference = bStore.encode({ file: first }) as { file: unknown };
    await settle();
    const back = aStore.decode({ file: reference.file }) as { file: RemoteBlob };

    expect([...new Uint8Array(await back.file.arrayBuffer())]).toEqual([9, 8, 7]);
    aStore.close();
    bStore.close();
  });

  it("is refused before a chunk is asked for when it is over the reader's bound", async () => {
    const { b, aStore, bStore } = wire({ b: { maxBytes: 4 } });
    const source = fileOf(new Uint8Array([1, 2, 3, 4, 5]));

    const file = await handOverBlob(aStore, bStore, source);
    await settle();

    expect(b.frames.some((frame) => "$streamFail" in frame)).toBe(true);
    expect(source.reads.count).toBe(0);
    await expect(file.arrayBuffer()).rejects.toThrow(/over this side's bound/);
    aStore.close();
    bStore.close();
  });
});

/** The same hand-over, for a value that comes back as bytes. */
async function handOverBytes(from: StreamStore, to: StreamStore, value: unknown): Promise<{ carried: RemoteBytes }> {
  const reference = from.encode({ data: value }) as { data: unknown };
  await settle();
  const decoded = to.decode({ data: reference.data }) as { data: unknown };
  expect(decoded.data).toBeInstanceOf(RemoteBytes);
  // Wrapped: a `RemoteBytes` is a thenable, and a promise resolving to one adopts it — the helper
  // would hand back the array instead of the handle.  The object keeps the value intact.
  return { carried: decoded.data as RemoteBytes };
}

describe("a typed array on the wire", () => {
  it("states its length on the reference and is asked for the moment it is named", async () => {
    const { a, aStore, bStore } = wire({ a: { chunkBytes: 4 } });
    const source = new Uint8Array([1, 2, 3, 4, 5, 6]);

    const { carried } = await handOverBytes(aStore, bStore, source);
    // Not lazy: the reference arriving is the demand, so the octets are already on their way here
    // before anything on this side reads the value.
    await settle();
    expect(a.sentOctets()).toBe(6);

    expect(carried.size).toBe(6);
    expect([...(await carried)]).toEqual([1, 2, 3, 4, 5, 6]);
    aStore.close();
    bStore.close();
  });

  it("is refused before a chunk is asked for when it is over the reader's bound", async () => {
    const { a, b, aStore, bStore } = wire({ b: { maxBytes: 4 } });
    const { carried } = await handOverBytes(aStore, bStore, new Uint8Array([1, 2, 3, 4, 5]));
    await settle();

    expect(b.frames.some((frame) => "$streamFail" in frame)).toBe(true);
    expect(b.frames.some((frame) => "$streamAsk" in frame)).toBe(false);
    expect(a.sentOctets()).toBe(0);
    await expect(carried.bytes()).rejects.toThrow(/over this side's bound of 4/);
    aStore.close();
    bStore.close();
  });

  it("says how short it was when fewer octets arrive than the reference stated", async () => {
    const { b, aStore, bStore } = wire();
    const four = new Uint8Array([1, 2, 3, 4]);
    b.deliver({ $stream: { id: 3 } });
    b.deliverSegment({ $chunk: { id: 3, seq: 0, bytes: 4 } }, four);
    b.deliver({ $chunkEnd: { id: 3, seq: 0, crc32: crc32(four) } });
    await settle();

    const carried = bStore.decode({ data: { $bytes: { id: 3, size: 8 } } }) as { data: RemoteBytes };
    b.deliver({ $streamDone: { id: 3 } });
    await expect(carried.data.bytes()).rejects.toThrow(/the array is short: 4 of 8 octets/);
    aStore.close();
    bStore.close();
  });

  it("refuses more octets than the reference stated", async () => {
    const { b, aStore, bStore } = wire();
    const four = new Uint8Array([1, 2, 3, 4]);
    b.deliver({ $stream: { id: 5 } });
    b.deliverSegment({ $chunk: { id: 5, seq: 0, bytes: 4 } }, four);
    b.deliver({ $chunkEnd: { id: 5, seq: 0, crc32: crc32(four) } });
    b.deliverSegment({ $chunk: { id: 5, seq: 1, bytes: 4 } }, four);
    b.deliver({ $chunkEnd: { id: 5, seq: 1, crc32: crc32(four) } });
    await settle();

    const carried = bStore.decode({ data: { $bytes: { id: 5, size: 4 } } }) as { data: RemoteBytes };
    await expect(carried.data.bytes()).rejects.toThrow(/longer than the 4 bytes it stated/);
    // The far side is told to stop: the value is over, whatever it was going to send.
    await settle();
    expect(b.frames.some((frame) => "$streamCancel" in frame)).toBe(true);
    aStore.close();
    bStore.close();
  });
});
