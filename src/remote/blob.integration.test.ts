// ── ten megabytes over a fifo, between two processes, twice ────────────────
//
// The unit tests drive one side of the seam at a time.  This one puts a real wire between
// two real processes and moves a file big enough that the chunking, the framing and the
// fifo itself all have to hold — and it does it the way an application would: a body with
// bytes in it goes out, and the answer's own value is awaited for the bytes that come back.
// Nothing in the test names a reference; the peer, being hand-written, does.
//
// The peer (`fixtures/blob-peer.js`) speaks the frames by hand rather than importing the
// library, so what is tested is the wire format and not one implementation's reading of it.

import { describe, it, expect, afterEach } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";

import { FifoUtf8NlineTransport } from "./transports/fifo.js";
import { json1Channel } from "./protocols/json1.js";
import { BlobHandle, BlobStore, blobValue } from "./blob.js";
import { decodeFrame, encodeFrame, type Channel } from "./channel.js";
import { ProcessTable } from "./process-ref.js";

const MB = 1024 * 1024;
const SIZE = 10 * MB;
const CHUNK = 64 * 1024;

const cleanupPaths: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const path of cleanupPaths.splice(0)) await unlink(path).catch(() => {});
});

/** Ten megabytes that are not a run of zeros: random, so a chunk that is lost, doubled or
 *  reordered cannot pass as the original. */
function payload(size: number): Uint8Array {
  return new Uint8Array(randomBytes(size));
}

/** The frames that came off the wire, and a way to wait for one without polling. */
class Frames {
  readonly all: Record<string, unknown>[] = [];
  private readonly waiters: Array<{
    match: (frame: Record<string, unknown>) => boolean;
    done: (frame: Record<string, unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  push(frame: Record<string, unknown>): void {
    this.all.push(frame);
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(frame)) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.done(frame);
    }
  }

  /** The first frame matching `match` — what already arrived counts, so a caller may ask
   *  after the fact; the deadline is the guard, and it says what it waited for. */
  next(
    match: (frame: Record<string, unknown>) => boolean,
    what: string,
    ms = 45_000,
  ): Promise<Record<string, unknown>> {
    const found = this.all.find(match);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error(`no ${what} within ${ms}ms; saw ${this.all.length} frames`));
      }, ms);
      this.waiters.push({
        match,
        done: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        timer,
      });
    });
  }
}

function bodyOf(frame: Record<string, unknown>): Record<string, unknown> {
  const msg = frame.$msg as { body?: Record<string, unknown> } | undefined;
  return msg?.body ?? {};
}

/** Two fifos, a peer on the far end of them, and the connection this side holds. */
async function withPeer(): Promise<{ channel: Channel; frames: Frames }> {
  const here = dirname(import.meta.url.slice(7));
  const peerPath = join(here, "./fixtures/blob-peer.js");

  const base = join(tmpdir(), `blob-test-${randomUUID()}`);
  const pathIn = `${base}.in`;
  const pathOut = `${base}.out`;
  cleanupPaths.push(pathIn, pathOut);
  execSync(`mkfifo "${pathIn}"`);
  execSync(`mkfifo "${pathOut}"`);

  const setup = FifoUtf8NlineTransport.beginConnect(pathIn, pathOut);
  const peer = spawn(process.argv[0]!, [peerPath, `--fifo-in=${pathIn}`, `--fifo-out=${pathOut}`], {
    cwd: process.cwd(),
    stdio: ["inherit", "inherit", "inherit"],
  });
  children.push(peer);

  const transport = await setup.transport;
  const channel: Channel = json1Channel(transport);
  const frames = new Frames();
  channel.onMessage((frame) => frames.push(frame));
  return { channel, frames };
}

const answered = (frame: Record<string, unknown>): boolean =>
  ["BLOB_ECHO", "BLOB_ERROR"].includes(bodyOf(frame).type as string);

/** How a frame is written here: the same call the connection makes, on the test's own channel. */
const table = new ProcessTable("odd");
const send = (channel: Channel, store: BlobStore, body: Record<string, unknown>): Promise<void> =>
  Promise.resolve(channel.send(encodeFrame({ $msg: { fromName: "test", body } }, table, 1, store)));

describe("a blob across a fifo", () => {
  it("carries ten megabytes out and back, as a body with bytes in it", async () => {
    const { channel, frames } = await withPeer();
    const store = new BlobStore(channel, "odd", { chunkBytes: CHUNK });

    const bytes = payload(SIZE);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(store.held()).toEqual([]);

    const started = Date.now();
    // The application writes bytes.  Nothing here knows a reference exists.
    await send(channel, store, { type: "READ_BLOB", blob: bytes });
    const raw = await frames.next(answered, "the peer's answer");
    const elapsed = Date.now() - started;

    const decoded = decodeFrame(raw, (ref) => ref, store) as { $msg: { body: Record<string, unknown> } };
    const body = decoded.$msg.body;

    expect(body.type).toBe("BLOB_ECHO");
    // Out: the peer hashed what it assembled, the test hashed the original.
    expect(body.declared).toBe(SIZE);
    expect(body.mime).toBeUndefined();
    expect(body.bytes).toBe(SIZE);
    expect(body.sha256).toBe(sha256);
    expect(body.chunks).toBe(Math.ceil(SIZE / CHUNK));
    expect(body.endBytes).toBe(SIZE);

    // Back: a value with the facts on it, whose await is the bytes — the same line an
    // application writes when the peer is a process in this one.
    const echoed = body.blob as BlobHandle;
    expect(echoed).toBeInstanceOf(BlobHandle);
    expect(echoed.size).toBe(SIZE);
    const returned = await echoed;
    expect(returned.byteLength).toBe(SIZE);
    expect(createHash("sha256").update(returned).digest("hex")).toBe(sha256);

    // A guard, not a benchmark: a minute would mean something is holding the wire up.
    expect(elapsed).toBeLessThan(45_000);

    await send(channel, store, { type: "STOP" });
    const exit = await frames.next((frame) => "$exit" in frame, "the peer's exit");
    expect((exit.$exit as { code: number }).code).toBe(0);
    await channel.close();
  }, 60_000);

  it("refuses a blob the peer cannot be given, and says why", async () => {
    const { channel, frames } = await withPeer();
    const store = new BlobStore(channel, "odd");

    // The reference promises four bytes and the offer cannot produce them: the peer is told
    // why, and no chunk of the wrong length is sent for it to find out by reading.
    const ref = store.offer({
      size: 4,
      name: "missing.bin",
      open: () => {
        throw new Error("ENOENT: no such file, open '/tmp/missing.bin'");
      },
    });

    await channel.send({ $msg: { fromName: "test", body: { type: "READ_BLOB", blob: blobValue(ref) } } });
    const answer = bodyOf(await frames.next(answered, "the peer's answer"));

    expect(answer.type).toBe("BLOB_ERROR");
    expect(answer.reason).toBe(`blob ${ref.id} could not be read: ENOENT: no such file, open '/tmp/missing.bin'`);

    await send(channel, store, { type: "STOP" });
    await frames.next((frame) => "$exit" in frame, "the peer's exit");
    await channel.close();
  }, 60_000);
});
