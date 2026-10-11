// ── the connection as byte streams ─────────────────────────────────────────
//
// A channel the test holds both ends of, and a logger that keeps what it is told.

import { describe, expect, it } from "vitest";
import type { Writable } from "node:stream";

import type { LineLog } from "./streams.js";
import { frameReaders, type Channel } from "./channel.js";
import { connectionFds, logStream } from "./streams.js";

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

describe("connectionFds", () => {
  it("writes what this end's root says as frames of the connection", async () => {
    const channel = new FakeChannel();
    const fds = connectionFds(channel);

    await write(fds.stdout.write, "hello\n");
    await write(fds.stderr.write, "it broke\n");
    await write(fds.stdin.write, "typed");

    expect(channel.sent).toEqual([
      { $fd: 1, data: "hello\n" },
      { $fd: 2, data: "it broke\n" },
      { $fd: 0, data: "typed" },
    ]);
  });

  it("reads the far end's frames as the stream that names them", async () => {
    const channel = new FakeChannel();
    const fds = connectionFds(channel);
    const heard: string[] = [];
    const got = new Promise<void>((resolve) => {
      fds.stderr.read.on("data", (chunk: Buffer) => {
        heard.push(String(chunk));
        resolve();
      });
    });

    channel.receive({ $fd: 2, data: "boom\n" });
    await got;

    expect(heard.join("")).toBe("boom\n");
  });

  it("stops reading the connection, and ends its streams, when it is closed", async () => {
    const channel = new FakeChannel();
    const fds = connectionFds(channel);
    const heard: string[] = [];
    fds.stdout.read.on("data", (chunk: Buffer) => heard.push(String(chunk)));
    const ended = new Promise<void>((resolve) => fds.stdout.read.on("end", resolve));

    channel.receive({ $fd: 1, data: "before\n" });
    fds.close();
    channel.receive({ $fd: 1, data: "after\n" });
    await ended;

    expect(heard.join("")).toBe("before\n");
  });
});

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
    const stream = logStream(collectingLog(lines), { fd: 2 });

    await write(stream, "it broke\n");

    expect(lines).toEqual(["warn it broke"]);
  });
});
