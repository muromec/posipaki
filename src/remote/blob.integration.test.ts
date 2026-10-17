// ── bytes across a real process boundary ───────────────────────────────────
//
// What a connection does with a file, end to end: a payload in a process of its own, asked
// through the public client, and answering with a digest of what it read.  The sizes are the
// ones a file comes in — a line of text, a screenshot, a document, a photo, and something
// big enough that copying it is a decision — and each is its own case so a failure names it.
//
// The digest rather than the bytes: sending the file back would only prove the same path
// twice, and the digest is the thing that changes when a chunk is lost, doubled or
// reordered.  It is bytes too, so it crosses the same way the file did.

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { remoteClient } from "./client.js";
import type { HandlerOptions, MethodOptions } from "../actor-types.js";
import { commandSpawner } from "./spawners/fifo-command.js";
import type { Message } from "../types.js";

/** What this test asks of the far side: one method, taking bytes, answering with bytes. */
type Reader = { "probe.sha256"(bytes: Uint8Array): Promise<unknown> };

const fixture = join(dirname(import.meta.url.slice(7)), "./fixtures/blob-payload.js");

async function spawnReader() {
  // The reflection surface is stated in the client's own types, so what the far side can be
  // asked is checked here rather than asserted after the fact.
  const actor = remoteClient<
    Record<string, unknown>,
    Record<string, unknown>,
    Message,
    Message,
    MethodOptions,
    HandlerOptions<Message>,
    Reader
  >("reader", commandSpawner([process.argv[0], fixture]));
  const proc = await actor.spawn({});
  return { proc, surface: proc.$reflection };
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
        const { proc, surface } = await spawnReader();

        const sent = new Uint8Array(randomBytes(size));
        const digest = createHash("sha256").update(sent).digest();

        const started = Date.now();
        const answer = await surface["probe.sha256"](sent);
        const back = new Uint8Array((await answer) as ArrayLike<number>);
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
