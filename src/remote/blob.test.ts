// ── blobs, one side at a time ──────────────────────────────────────────────
//
// Each side of the seam is driven by hand here: a fake channel keeps what the side sent
// and hands it a frame as if it had come from the other end.  What crosses a real wire is
// the integration test's business (`blob.integration.test.ts`); what a side *promises* —
// numbering, laziness, the limit, a sentence when a read cannot be served — is this file's.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { frameReaders, type Channel } from "./channel.js";
import {
  BlobStore,
  blobDataOf,
  blobEndOf,
  blobFailOf,
  blobValue,
  type BlobRef,
} from "./blob.js";

class FakeChannel implements Channel {
  readonly sent: Record<string, unknown>[] = [];
  private deliver: (frame: Record<string, unknown>) => void = () => {};
  private readonly waiters: Array<{ count: number; done: () => void }> = [];
  private readonly readers = frameReaders((deliver) => {
    this.deliver = deliver;
  });

  async send(frame: Record<string, unknown>): Promise<void> {
    this.sent.push(frame);
    for (const waiter of [...this.waiters]) {
      if (this.sent.length >= waiter.count) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.done();
      }
    }
  }

  onMessage(handler: (frame: Record<string, unknown>) => void): () => void {
    return this.readers(handler);
  }

  onClose(): void {
    /* nothing here closes the fake */
  }

  async close(): Promise<void> {
    /* nothing to release */
  }

  /** A frame from the far side. */
  receive(frame: Record<string, unknown>): void {
    this.deliver(frame);
  }

  /** Resolved once this many frames have been sent — the step, armed before the act. */
  until(count: number): Promise<void> {
    if (this.sent.length >= count) return Promise.resolve();
    return new Promise((done) => this.waiters.push({ count, done }));
  }
}

/** A blob this side offers, with a counter of how often its bytes were actually opened. */
function offered(
  bytes: Uint8Array,
  extra: { mime?: string; name?: string; sha256?: string; declared?: number } = {},
) {
  const opened = { count: 0 };
  return {
    opened,
    offer: {
      size: extra.declared ?? bytes.byteLength,
      mime: extra.mime,
      name: extra.name,
      sha256: extra.sha256,
      open: (): Uint8Array => {
        opened.count += 1;
        return bytes;
      },
    },
  };
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("a blob's reference", () => {
  it("is numbered on this side's parity, once per offer, and says what it knows", () => {
    const channel = new FakeChannel();
    const even = new BlobStore(channel, "even");
    const first = offered(text("one"), { mime: "image/png", name: "shot.png" });
    const second = offered(text("two"));

    const a = even.offer(first.offer);
    const b = even.offer(second.offer);

    expect(a).toEqual({ id: 0, size: 3, mime: "image/png", name: "shot.png" });
    expect(b).toEqual({ id: 2, size: 3 });
    // The same offer is the same blob: numbering it twice would be two ids for one file.
    expect(even.offer(first.offer)).toEqual(a);
    expect(even.held()).toEqual([0, 2]);

    const odd = new BlobStore(new FakeChannel(), "odd");
    expect(odd.offer(second.offer)).toEqual({ id: 1, size: 3 });
  });

  it("crosses as a value that is only JSON", () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "even");
    const ref = store.offer(offered(text("x"), { name: "a.txt" }).offer);

    const value = blobValue(ref);
    expect(JSON.parse(JSON.stringify(value))).toEqual({ $b: { id: 0, size: 1, name: "a.txt" } });
    expect(store.handle(value)?.id).toBe(0);
    // A body that carries no file is not an error, it is a body with no file in it.
    expect(store.handle({ something: "else" })).toBeNull();
    expect(store.handle(undefined)).toBeNull();
  });

  it("is offered without being opened", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "even");
    const blob = offered(text("nobody reads this"));
    store.offer(blob.offer);

    expect(blob.opened.count).toBe(0);
    expect(channel.sent).toEqual([]);
  });
});

describe("answering a read", () => {
  it("sends the chunks, then the count", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "even", { chunkBytes: 4 });
    const bytes = text("0123456789");
    const ref = store.offer(offered(bytes).offer);

    channel.receive({ $blobAsk: { id: ref.id, seq: 7 } });
    await channel.until(4);

    expect(channel.sent.map((frame) => Object.keys(frame)[0])).toEqual([
      "$blobData",
      "$blobData",
      "$blobData",
      "$blobEnd",
    ]);
    expect(channel.sent.slice(0, 3).map((frame) => blobDataOf(frame)?.data)).toEqual([
      Buffer.from("0123").toString("base64"),
      Buffer.from("4567").toString("base64"),
      Buffer.from("89").toString("base64"),
    ]);
    expect(blobEndOf(channel.sent[3]!)).toEqual({ seq: 7, bytes: 10 });
  });

  it("refuses an id it does not hold, by name", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "even");
    channel.receive({ $blobAsk: { id: 9, seq: 4 } });

    await channel.until(1);
    expect(blobFailOf(channel.sent[0]!)).toEqual({ seq: 4, reason: "no such blob: 9" });
  });

  it("says why when the bytes cannot be opened", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "even");
    const ref = store.offer({
      size: 3,
      open: () => {
        throw new Error("no such file: /tmp/shot.png");
      },
    });

    channel.receive({ $blobAsk: { id: ref.id, seq: 2 } });
    await channel.until(1);
    expect(blobFailOf(channel.sent[0]!)?.reason).toBe("blob 0 could not be read: no such file: /tmp/shot.png");
  });

  it("refuses bytes that disagree with the reference instead of sending them", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "even");
    const ref = store.offer(offered(text("123456"), { declared: 5 }).offer);

    channel.receive({ $blobAsk: { id: ref.id, seq: 1 } });
    await channel.until(1);
    expect(channel.sent).toHaveLength(1);
    expect(blobFailOf(channel.sent[0]!)?.reason).toBe("blob 0 is 6 bytes, its reference said 5");
  });

  it("takes the blob away when it is released", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "even");
    const ref = store.offer(offered(text("gone")).offer);

    expect(store.release(ref.id)).toBe(true);
    expect(store.release(ref.id)).toBe(false);

    channel.receive({ $blobAsk: { id: ref.id, seq: 3 } });
    await channel.until(1);
    expect(blobFailOf(channel.sent[0]!)?.reason).toBe("no such blob: 0");
  });

  it("refuses a read still in flight when the connection closes", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "odd");
    const handle = store.handle({ $b: { id: 2, size: 4 } });
    expect(handle).not.toBeNull();

    const read = handle!.read();
    await channel.until(1);
    store.close();

    await expect(read).rejects.toThrow("the connection closed before the blob arrived");
  });
});

describe("reading a blob", () => {
  it("asks by id and gives back what came", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "odd");
    const handle = store.handle({ $b: { id: 8, size: 11, name: "a.txt" } });
    expect(handle?.name).toBe("a.txt");

    const read = handle!.read();
    await channel.until(1);
    expect(channel.sent[0]).toEqual({ $blobAsk: { id: 8, seq: 1 } });

    channel.receive({ $blobData: { seq: 1, data: Buffer.from("hello ").toString("base64") } });
    channel.receive({ $blobData: { seq: 1, data: Buffer.from("world").toString("base64") } });
    channel.receive({ $blobEnd: { seq: 1, bytes: 11 } });

    expect(new TextDecoder().decode(await read)).toBe("hello world");
  });

  it("carries every byte value, including the ones a text wire mangles", async () => {
    // A PNG's header and a UTF-8 character and the bytes of a lone surrogate: nothing here
    // is text, and every one of them has to come back as it went.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0xc3, 0xa9]);
    const writer = new FakeChannel();
    const reader = new FakeChannel();
    const source = new BlobStore(writer, "even");
    const sink = new BlobStore(reader, "odd");
    const ref = source.offer(offered(bytes, { sha256: createHash("sha256").update(bytes).digest("hex") }).offer);

    writer.receive({ $blobAsk: { id: ref.id, seq: 1 } });
    await writer.until(2);

    const read = sink.handle(blobValue(ref))!.read();
    await reader.until(1);
    for (const frame of writer.sent) reader.receive(frame);

    expect(Array.from(await read)).toEqual(Array.from(bytes));
  });

  it("refuses a blob over this side's limit before asking for it", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "odd", { maxBytes: 1024 });
    const handle = store.handle({ $b: { id: 3, size: 10 * 1024 * 1024 } });

    await expect(handle!.read()).rejects.toThrow(
      `blob 3 is ${10 * 1024 * 1024} bytes, over this side's 1024-byte limit`,
    );
    expect(channel.sent).toEqual([]);
  });

  it("passes on the reason the other side gave", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "odd");
    const read = store.handle({ $b: { id: 5, size: 2 } })!.read();
    await channel.until(1);

    channel.receive({ $blobFail: { seq: 1, reason: "no such blob: 5" } });
    await expect(read).rejects.toThrow("no such blob: 5");
  });

  it("refuses an answer that ends at a length its reference did not promise", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "odd");
    const short = store.handle({ $b: { id: 4, size: 6 } })!.read();
    await channel.until(1);
    channel.receive({ $blobData: { seq: 1, data: Buffer.from("abc").toString("base64") } });
    channel.receive({ $blobEnd: { seq: 1, bytes: 3 } });
    await expect(short).rejects.toThrow("blob 4 ended at 3 bytes, its reference said 6");

    // …and the length the answer claims for itself has to be the length it delivered.
    const overrun = store.handle({ $b: { id: 4, size: 3 } })!.read();
    await channel.until(2);
    channel.receive({ $blobData: { seq: 2, data: Buffer.from("abcd").toString("base64") } });
    channel.receive({ $blobEnd: { seq: 2, bytes: 9 } });
    await expect(overrun).rejects.toThrow("blob 2 ended at 4 bytes, its last frame said 9");
  });

  it("tells two reads in flight apart by their seq", async () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "odd");
    const first = store.handle({ $b: { id: 1, size: 3 } })!.read();
    const second = store.handle({ $b: { id: 1, size: 3 } })!.read();
    await channel.until(2);

    // Answered out of order, which is what a connection is allowed to do.
    channel.receive({ $blobData: { seq: 2, data: Buffer.from("bbb").toString("base64") } });
    channel.receive({ $blobEnd: { seq: 2, bytes: 3 } });
    channel.receive({ $blobData: { seq: 1, data: Buffer.from("aaa").toString("base64") } });
    channel.receive({ $blobEnd: { seq: 1, bytes: 3 } });

    expect(new TextDecoder().decode(await first)).toBe("aaa");
    expect(new TextDecoder().decode(await second)).toBe("bbb");
  });

  it("keeps the facts a reader decides on before pulling", () => {
    const store = new BlobStore(new FakeChannel(), "odd");
    const ref: BlobRef = { id: 2, size: 12, mime: "image/png", name: "shot.png", sha256: "ab" };
    const handle = store.handle(blobValue(ref));
    expect({ id: handle?.id, size: handle?.size, mime: handle?.mime, sha256: handle?.sha256 }).toEqual({
      id: 2,
      size: 12,
      mime: "image/png",
      sha256: "ab",
    });
  });
});

describe("bytes cross without the application naming a reference", () => {
  it("turns a byte array anywhere in a body into one reference this side serves", () => {
    const channel = new FakeChannel();
    const store = new BlobStore(channel, "even");
    const bytes = text("hello");
    const note = { file: bytes, label: "one" };

    const encoded = store.encode({ $msg: { fromName: "a", body: note } }) as {
      $msg: { body: { file: unknown; label: string } };
    };

    expect(encoded.$msg.body.file).toEqual({ $b: { id: 0, size: 5 } });
    expect(encoded.$msg.body.label).toBe("one");
    expect(store.held()).toEqual([0]);
    // The walk copies: the application's own object is not rewritten under it.
    expect(note.file).toBe(bytes);
    expect(bytes.byteLength).toBe(5);
  });

  it("treats a Buffer and an ArrayBuffer as bytes too", () => {
    const store = new BlobStore(new FakeChannel(), "even");
    const fromBuffer = store.encode({ a: Buffer.from("abc") }) as { a: { $b: { size: number } } };
    const fromArray = store.encode({ a: new Uint8Array([1, 2, 3, 4]).buffer }) as { a: { $b: { size: number } } };
    expect(fromBuffer.a.$b.size).toBe(3);
    expect(fromArray.a.$b.size).toBe(4);
  });

  it("hands the reader a value whose await is the bytes, as a local one already is", async () => {
    const writer = new FakeChannel();
    const reader = new FakeChannel();
    const source = new BlobStore(writer, "even");
    const sink = new BlobStore(reader, "odd");
    const bytes = text("the bytes");

    const frame = source.encode({ $msg: { fromName: "a", body: { file: bytes } } }) as Record<string, unknown>;
    const decoded = sink.decode(frame) as {
      $msg: { body: { file: { size: number } & PromiseLike<Uint8Array> } };
    };

    // What an application wrote: one line, the same one it writes to a process in this
    // process.  What it gets: the bytes.
    const value = decoded.$msg.body.file;
    expect(value.size).toBe(9);
    const read = Promise.resolve(value);

    writer.receive({ $blobAsk: { id: 0, seq: 1 } });
    await writer.until(2);
    for (const sent of writer.sent) reader.receive(sent);

    expect(new TextDecoder().decode(await read)).toBe("the bytes");
  });

  it("leaves alone what is not bytes", () => {
    const store = new BlobStore(new FakeChannel(), "even");
    const value = { when: new Date(0), set: new Set([1]), text: "é", n: 1 };
    const encoded = store.encode(value) as Record<string, unknown>;
    expect(encoded.text).toBe("é");
    expect(encoded.n).toBe(1);
    expect(encoded.when).toBe(value.when);
    expect(encoded.set).toBe(value.set);
  });
});
