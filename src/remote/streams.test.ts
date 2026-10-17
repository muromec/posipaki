// ── the connection as byte streams ─────────────────────────────────────────
//
// A channel the test holds both ends of, and a logger that keeps what it is told.

import { describe, expect, it } from "vitest";
import type { Writable } from "node:stream";

import { frameReaders, type Channel } from "./channel.js";
import { logStream, type LineLog } from "./streams.js";

class FakeChannel implements Channel {
  readonly sent: Record<string, unknown>[] = [];
  private deliver: (frame: Record<string, unknown>) => void = () => {};
  private readonly readers = frameReaders((deliver) => {
    this.deliver = deliver;
  });

  async send(frame: Record<string, unknown>): Promise<void> {
    this.sent.push(frame);
  }
  onMessage(handler: (frame: Record<string, unknown>) => void): () => void {
    return this.readers(handler);
  }
  onClose(): void {
    /* nothing here closes the test's channel */
  }
  async close(): Promise<void> {
    /* nothing to release */
  }
  /** A frame from the far side. */
  receive(frame: Record<string, unknown>): void {
    this.deliver(frame);
  }
}

/** A log that keeps every line, with the level it arrived as: the two methods the seam asks for. */
function collectingLog(lines: string[]): LineLog {
  return {
    info: (message: string) => void lines.push(`info ${message}`),
    warn: (message: string) => void lines.push(`warn ${message}`),
  };
}

/** Write a chunk, and answer when the stream has taken it. */
function write(to: Writable, chunk: string): Promise<void> {
  return new Promise((done) => to.write(chunk, () => done()));
}

describe("logStream", () => {
  it("turns chunks into lines, holding the tail until it is finished", async () => {
    const lines: string[] = [];
    const stream = logStream(collectingLog(lines));

    await write(stream, "one\ntwo");
    expect(lines).toEqual(["info one"]);

    await write(stream, " and a half\n");
    expect(lines).toEqual(["info one", "info two and a half"]);

    await write(stream, "last, no newline");
    await new Promise<void>((done) => stream.end(() => done()));
    expect(lines).toEqual(["info one", "info two and a half", "info last, no newline"]);
  });

  it("sends what a stream calls an error to warn", async () => {
    const lines: string[] = [];
    const stream = logStream(collectingLog(lines), { name: "stderr" });

    await write(stream, "it broke\n");

    expect(lines).toEqual(["warn it broke"]);
  });
});
