// ── streams across a real process boundary ─────────────────────────────────
//
// End to end over the path an application uses: an ordinary message carrying a stream goes out,
// the payload in a process of its own reads it to the end, and answers with the digest — and the
// other way round, the payload answers with a stream it makes itself.
//
// The sizes are what files come in, and each is its own case so a failure names it.  What the
// digest proves is that no chunk was lost, doubled or reordered: the bytes are read on the far
// side of the wire, not compared here.

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { remoteClient } from "./client.js";
import { nextMessage } from "../testing/index.js";
import { commandSpawner } from "./spawners/fifo-command.js";
import type { Message } from "../types.js";

type File = AsyncIterable<Uint8Array>;

/** A whole file the far side reads on demand: sized, named, and asked for its bytes. */
type Blobish = { size: number; type?: string; arrayBuffer(): Promise<ArrayBuffer> };
type Hash = { type: "HASH"; file: File | Blobish } & Message;
type Serve = { type: "SERVE"; chunks: number; size: number } & Message;
type Hashed = { type: "HASHED"; digest: Uint8Array | PromiseLike<Uint8Array>; bytes: number; chunks: number } & Message;
type Served = { type: "SERVED"; file: File | PromiseLike<File> } & Message;

const fixture = join(dirname(import.meta.url.slice(7)), "./fixtures/stream-payload.js");

/** A client for the payload, typed by the traffic the case means to have with it. */
async function spawnStreamer<In extends Message, Out extends Message>() {
  const actor = remoteClient<Record<string, unknown>, Record<string, unknown>, In, Out>(
    "streamer",
    commandSpawner([process.argv[0], fixture]),
  );
  return actor.spawn({});
}

/** A stream of `chunks` pieces of `size` octets, filled with the chunk's index. */
function streamOf(chunks: number, size: number): AsyncIterable<Uint8Array> & { pulled: number } {
  const source = {
    pulled: 0,
    async *[Symbol.asyncIterator]() {
      for (let index = 1; index <= chunks; index += 1) {
        source.pulled += 1;
        yield new Uint8Array(size).fill(index % 256);
      }
    },
  };
  return source;
}

/** What a stream of `chunks` pieces of `size` octets hashes to, computed the same way on both sides. */
function digestOf(chunks: number, size: number): string {
  const hash = createHash("sha256");
  for (let index = 1; index <= chunks; index += 1) hash.update(new Uint8Array(size).fill(index % 256));
  return hash.digest("hex");
}

const SIZES: Array<[string, number, number]> = [
  ["1 chunk", 1, 1024],
  ["1 MiB in 64 KiB chunks", 16, 64 * 1024],
  ["10 MiB in 64 KiB chunks", 160, 64 * 1024],
  ["10 MiB in unequal chunks", 10, 1024 * 1024],
];

describe("streams across a process boundary", () => {
  for (const [label, chunks, size] of SIZES) {
    const guard = chunks * size >= 10 * 1024 * 1024 ? 60_000 : 20_000;

    it(
      `reads ${label} the far side over an ordinary message`,
      async () => {
        const proc = await spawnStreamer<Hash, Hashed>();
        const source = streamOf(chunks, size);

        const started = Date.now();
        // Armed before the send: the answer can arrive before a caller looks.
        const answer = nextMessage(proc);
        proc.send({ type: "HASH", file: source });
        const heard = await answer;
        const elapsed = Date.now() - started;

        expect(Buffer.from(new Uint8Array(await heard.digest)).toString("hex")).toBe(digestOf(chunks, size));
        expect(heard.bytes).toBe(chunks * size);
        expect(heard.chunks).toBeGreaterThanOrEqual(chunks);
        // The source was read, not buffered: every piece it had was pulled.
        expect(source.pulled).toBe(chunks);
        expect(elapsed).toBeLessThan(guard);

        await proc.stop();
      },
      guard + 5_000,
    );
  }

  it(
    "hands a stream back, which this side reads at its own pace",
    async () => {
      const proc = await spawnStreamer<Serve, Served>();
      const chunks = 16;
      const size = 64 * 1024;

      const answer = nextMessage(proc);
      proc.send({ type: "SERVE", chunks, size });
      const heard = await answer;
      const file = (await heard.file) as File;

      const hash = createHash("sha256");
      let read = 0;
      for await (const chunk of file) {
        hash.update(chunk);
        read += chunk.length;
      }

      expect(read).toBe(chunks * size);
      expect(hash.digest("hex")).toBe(digestOf(chunks, size));

      await proc.stop();
    },
    60_000,
  );

  it("carries bytes that are not text", async () => {
    // Any octet may appear in a chunk, line endings and invalid UTF-8 included; a medium that
    // decoded them as text would change the digest.
    const proc = await spawnStreamer<Hash, Hashed>();
    const bytes = new Uint8Array(randomBytes(4096));

    const answer = nextMessage(proc);
    proc.send({
      type: "HASH",
      file: {
        async *[Symbol.asyncIterator]() {
          yield bytes.subarray(0, 2048);
          yield bytes.subarray(2048);
        },
      },
    });
    const heard = await answer;

    expect(Buffer.from(new Uint8Array(await heard.digest)).toString("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    await proc.stop();
  });

  it("carries a blob, which the far side reads on demand", async () => {
    // A file the way an application has one: sized and typed, its bytes still here until asked for.
    const proc = await spawnStreamer<Hash, Hashed>();
    const bytes = randomBytes(512 * 1024);
    const file = new Blob([bytes], { type: "application/octet-stream" });

    const answer = nextMessage(proc);
    proc.send({ type: "HASH", file });
    const heard = await answer;

    expect(Buffer.from(new Uint8Array(await heard.digest)).toString("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(heard.bytes).toBe(bytes.length);
    await proc.stop();
  });
});
