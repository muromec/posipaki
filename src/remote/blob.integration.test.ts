// ── bytes across a real process boundary ───────────────────────────────────
//
// What a connection does with a file, end to end and over the path an application uses: a
// message with bytes in it goes out, the payload in a process of its own reads them, and it
// answers with a message carrying the digest.  The sizes are the ones a file comes in — a
// line of text, a screenshot, a document, a photo, and something big enough that copying it
// is a decision — and each is its own case so a failure names it.
//
// The digest rather than the bytes: sending the file back would only prove the same path
// twice, and the digest is what changes when a chunk is lost, doubled or reordered.  It is
// bytes too, so it crosses the same way the file did.

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { remoteClient } from "./client.js";
import { commandSpawner } from "./spawners/fifo-command.js";
import type { Message } from "../types.js";

/** What this test says, and what it expects back.  The digest is bytes either way: a
 *  `Uint8Array` when the far side is in this process, something to await when it is not. */
type Hash = { type: "HASH"; bytes: Uint8Array } & Message;
type Hashed = { type: "HASHED"; digest: Uint8Array | PromiseLike<Uint8Array> } & Message;

const fixture = join(dirname(import.meta.url.slice(7)), "./fixtures/blob-payload.js");

async function spawnReader() {
  const actor = remoteClient<Record<string, unknown>, Record<string, unknown>, Hash, Hashed>(
    "reader",
    commandSpawner([process.argv[0], fixture]),
  );
  return actor.spawn({});
}

/** The far side's next message, with a guard that names what it waited for.  Armed before
 *  the act, because the answer can arrive before a caller looks. */
function nextMessage(proc: { subscribe(kind: "message", handler: (msg: Hashed) => void): () => void }, what: string, ms: number): Promise<Hashed> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`no ${what} within ${ms}ms`));
    }, ms);
    const stop = proc.subscribe("message", (msg) => {
      clearTimeout(timer);
      stop();
      resolve(msg);
    });
  });
}

const SIZES: Array<[string, number]> = [
  ["1 KiB", 1024],
  ["512 KiB", 512 * 1024],
  ["1 MiB", 1024 * 1024],
  ["10 MiB", 10 * 1024 * 1024],
  ["100 MiB", 100 * 1024 * 1024],
];

describe("bytes across a process boundary", () => {
  for (const [label, size] of SIZES) {
    // A big file is allowed more rope than a small one; either way it is a guard against a
    // wire that is being held, not a benchmark.
    const guard = size >= 100 * 1024 * 1024 ? 120_000 : 30_000;

    it(
      `carries ${label} of bytes, and the far side answers with their digest`,
      async () => {
        const proc = await spawnReader();

        const sent = new Uint8Array(randomBytes(size));
        const digest = createHash("sha256").update(sent).digest();

        const started = Date.now();
        const answer = nextMessage(proc, `${label} of bytes hashed`, guard);
        proc.send({ type: "HASH", bytes: sent });
        const heard = await answer;
        const back = new Uint8Array(await heard.digest);
        const elapsed = Date.now() - started;

        expect(back.byteLength).toBe(digest.byteLength);
        expect(Buffer.from(back).toString("hex")).toBe(digest.toString("hex"));
        expect(elapsed).toBeLessThan(guard);

        await proc.stop();
      },
      guard + 5_000,
    );
  }
});
