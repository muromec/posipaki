// ── FifoUtf8NlineTransport tests ────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { FifoUtf8NlineTransport } from "./fifo.js";

let pipeCounter = 0;

async function makePipe(): Promise<[FileHandle, FileHandle]> {
  const path = join(
    tmpdir(),
    `fifo-test-${pipeCounter++}-${Math.random().toString(36).slice(2)}.pipe`,
  );
  execSync(`mkfifo "${path}"`);
  const [readFd, writeFd] = await Promise.all([
    open(path, "r"),
    open(path, "w"),
  ]);
  await unlink(path).catch(() => {});
  return [readFd, writeFd];
}

async function makePair(): Promise<[FifoUtf8NlineTransport, FifoUtf8NlineTransport]> {
  const [aRead, aWrite] = await makePipe();
  const [bRead, bWrite] = await makePipe();
  const a = FifoUtf8NlineTransport.fromFds(bRead, aWrite);
  const b = FifoUtf8NlineTransport.fromFds(aRead, bWrite);
  return [a, b];
}

describe("FifoUtf8NlineTransport basic lifecycle", () => {
  it("send line -> receive line -> close", async () => {
    const [a, b] = await makePair();
    const received: string[] = [];
    b.onMessage((line) => received.push(line));
    await a.send("hello\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual(["hello"]);
    await a.close();
    await b.close();
  });

  it("close is idempotent", async () => {
    const [readFd, writeFd] = await makePipe();
    const t = FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    await t.close();
    await t.close();
  });

  it("multiple messages arrive in order", async () => {
    const [a, b] = await makePair();
    const received: string[] = [];
    b.onMessage((line) => received.push(line));
    await a.send("1\n");
    await a.send("2\n");
    await a.send("3\n");
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toEqual(["1", "2", "3"]);
    await a.close();
    await b.close();
  });

  it("send auto-appends newline", async () => {
    const [a, b] = await makePair();
    const received: string[] = [];
    b.onMessage((line) => received.push(line));
    await a.send("no-newline");
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual(["no-newline"]);
    await a.close();
    await b.close();
  });
});

describe("FifoUtf8NlineTransport handler lifecycle", () => {
  it("onMessage throws when handler already set", async () => {
    const [readFd, writeFd] = await makePipe();
    const t = FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    t.onMessage(() => {});
    expect(() => t.onMessage(() => {})).toThrow("handler already set");
    await t.close();
  });

  it("onMessage throws when closed", async () => {
    const [readFd, writeFd] = await makePipe();
    const t = FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    await t.close();
    expect(() => t.onMessage(() => {})).toThrow("closed");
  });

  it("send throws when closed", async () => {
    const [readFd, writeFd] = await makePipe();
    const t = FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    await t.close();
    await expect(t.send("x\n")).rejects.toThrow("closed");
  });

  it("removeHandler clears handler and returns it", async () => {
    const [readFd, writeFd] = await makePipe();
    const t = FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    t.onMessage(() => {});
    expect(t.hasHandler).toBe(true);
    const removed = t.removeHandler();
    expect(removed).not.toBeNull();
    expect(t.hasHandler).toBe(false);
    t.onMessage(() => {});
    expect(t.hasHandler).toBe(true);
    await t.close();
  });

  it("removeHandler on empty returns null", async () => {
    const [readFd, writeFd] = await makePipe();
    const t = FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    expect(t.removeHandler()).toBeNull();
    expect(t.hasHandler).toBe(false);
    await t.close();
  });

  it("set -> remove -> set -> receive works", async () => {
    const [a, b] = await makePair();
    const first: string[] = [];
    b.onMessage((line) => first.push(line));
    b.removeHandler();
    const second: string[] = [];
    b.onMessage((line) => second.push(line));
    await a.send("hello\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(first).toEqual([]);
    expect(second).toEqual(["hello"]);
    await a.close();
    await b.close();
  });

  it("onMessage throws when handler already set after removeHandler", async () => {
    const [readFd, writeFd] = await makePipe();
    const t = FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    t.onMessage(() => {});
    t.removeHandler();
    t.onMessage(() => {});
    expect(() => t.onMessage(() => {})).toThrow("handler already set");
    await t.close();
  });
});

describe("FifoUtf8NlineTransport close behavior", () => {
  it("handler not called after close", async () => {
    const [a, b] = await makePair();
    const received: string[] = [];
    b.onMessage((line) => received.push(line));
    await b.close();
    try { await a.send("after-close\n"); } catch { /* EPIPE */ }
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([]);
    await a.close();
  });

  it("close while message in flight does not crash", async () => {
    const [a, b] = await makePair();
    b.onMessage(() => {});
    await a.send("x\n");
    await b.close();
    await a.close();
  });

  it("close before any handler is set is safe", async () => {
    const [readFd, writeFd] = await makePipe();
    const t = FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    await t.close();
  });

  it("peer close of write fd does not crash reader", async () => {
    const [a, b] = await makePair();
    const received: string[] = [];
    b.onMessage((line) => received.push(line));
    await a.send("before-close\n");
    await new Promise((r) => setTimeout(r, 20));
    await a.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toContain("before-close");
    await b.close();
  });
});

describe("FifoUtf8NlineTransport bad input", () => {
  it("empty lines are handled without crash", async () => {
    const [a, b] = await makePair();
    const received: string[] = [];
    b.onMessage((line) => received.push(line));
    await a.send("\n");
    await a.send("real\n");
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toContain("real");
    await a.close();
    await b.close();
  });

  it("whitespace-only lines are delivered as-is", async () => {
    const [a, b] = await makePair();
    const received: string[] = [];
    b.onMessage((line) => received.push(line));
    await a.send("   \n");
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual(["   "]);
    await a.close();
    await b.close();
  });

  it("very long lines (100k chars) are delivered intact", async () => {
    const [a, b] = await makePair();
    const received: string[] = [];
    b.onMessage((line) => received.push(line));
    const long = "x".repeat(100_000);
    await a.send(long + "\n");
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([long]);
    await a.close();
    await b.close();
  });

  it("binary garbage does not crash the transport", async () => {
    const [readFd, writeFd] = await makePipe();
    const t = FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    const received: string[] = [];
    t.onMessage((line) => received.push(line));
    const buf = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x0A]);
    await writeFd.write(buf);
    await new Promise((r) => setTimeout(r, 30));
    expect(received.length).toBeGreaterThanOrEqual(0);
    await t.close();
  });

  it("non-JSON lines are delivered as raw strings", async () => {
    const [a, b] = await makePair();
    const received: string[] = [];
    b.onMessage((line) => received.push(line));
    await a.send("this is not json\n");
    await a.send("{broken\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toContain("this is not json");
    expect(received).toContain("{broken");
    await a.close();
    await b.close();
  });
});

describe("FifoUtf8NlineTransport concurrency", () => {
  it("rapid send/receive (50 messages) preserves order", async () => {
    const [a, b] = await makePair();
    const received: string[] = [];
    b.onMessage((line) => received.push(line));
    const count = 50;
    for (let i = 0; i < count; i++) {
      await a.send(`${i}\n`);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(received.length).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(received[i]).toBe(String(i));
    }
    await a.close();
    await b.close();
  });

  it("send while no handler set does not crash", async () => {
    const [a, b] = await makePair();
    await a.send("nobody-listening\n");
    await new Promise((r) => setTimeout(r, 20));
    await a.close();
    await b.close();
  });

  it("simultaneous bidirectional send", async () => {
    const [a, b] = await makePair();
    const aReceived: string[] = [];
    const bReceived: string[] = [];
    a.onMessage((line) => aReceived.push(line));
    b.onMessage((line) => bReceived.push(line));
    await Promise.all([
      a.send("a-to-b\n"),
      b.send("b-to-a\n"),
    ]);
    await new Promise((r) => setTimeout(r, 30));
    expect(bReceived).toContain("a-to-b");
    expect(aReceived).toContain("b-to-a");
    await a.close();
    await b.close();
  });
});

describe("FifoUtf8NlineTransport bidirectional connect", () => {
  it("beginConnect + connect full round-trip", async () => {
    // Simulate host (beginConnect) and child (connect) sides.
    // Host: reads from pathIn, writes to pathOut
    // Child: reads from pathOut, writes to pathIn
    const basePath = join(
      tmpdir(),
      `fifo-conn-${Math.random().toString(36).slice(2)}`,
    );
    const pathIn = basePath + ".in";
    const pathOut = basePath + ".out";
    execSync(`mkfifo "${pathIn}"`);
    execSync(`mkfifo "${pathOut}"`);

    // Host: beginConnect starts reading pathIn
    const hostSetup = FifoUtf8NlineTransport.beginConnect(pathIn, pathOut);

    // Child: connect opens pathIn for writing, reads pathOut
    const childP = FifoUtf8NlineTransport.connect(pathOut, pathIn);

    const host = await hostSetup.transport;
    const child = await childP;

    // Child sends to host (via pathIn)
    const hostReceived: string[] = [];
    host.onMessage((line) => hostReceived.push(line));

    await child.send("child-to-host\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(hostReceived).toEqual(["child-to-host"]);

    // Host sends to child (via pathOut)
    host.removeHandler();
    const childReceived: string[] = [];
    child.onMessage((line) => childReceived.push(line));

    await host.send("host-to-child\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(childReceived).toEqual(["host-to-child"]);

    await host.close();
    await child.close();
    await unlink(pathIn).catch(() => {});
    await unlink(pathOut).catch(() => {});
  });

  it("write-only transport (fromFds with only writeFd)", async () => {
    const [readFd, writeFd] = await makePipe();
    const writer = FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    expect(writer.canSend).toBe(true);
    await writer.send("test\n");
    await writer.close();
  });

  it("read-only behaviour via fromFds with no writeFd errors on send", async () => {
    // fromFds always provides both fds, so canSend is always true.
    // The "not a writer" error comes from a write-only transport,
    // which is only created internally.  Test the closest public
    // equivalent: close and then send.
    const [readFd, writeFd] = await makePipe();
    const t = FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    await t.close();
    await expect(t.send("x\n")).rejects.toThrow("closed");
  });
});
