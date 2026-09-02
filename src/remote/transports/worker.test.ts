// ── WorkerTransport tests (in-memory fake worker pair) ──────────────────────────
//
// No real-worker integration test: Bun canary (v1.3.13) on riscv64 segfaults at
// process exit once a worker has been spawned, so these cover the transport with
// a fake WorkerLike pair instead.  The seam is transport-agnostic, so the
// WebSocket integration test exercises the same lifecycle end to end.

import { describe, it, expect } from "vitest";
import { WorkerTransport, type WorkerLike } from "./worker.js";
import { makeWaiter } from "../../util.js";

class FakeWorker implements WorkerLike {
  peer: FakeWorker | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;

  postMessage(data: unknown): void {
    if (this.terminated) throw new Error("postMessage on terminated worker");
    this.peer?.deliver(data);
  }
  terminate(): void {
    this.terminated = true;
  }
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
  crash(err?: unknown): void {
    this.onerror?.(err ?? new Error("boom"));
  }
}

function makePair(): [FakeWorker, FakeWorker] {
  const a = new FakeWorker();
  const b = new FakeWorker();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe("WorkerTransport", () => {
  it("moves a frame object from one worker to the other", async () => {
    const [a, b] = makePair();
    const ta = new WorkerTransport(a);
    const tb = new WorkerTransport(b);

    const received = makeWaiter<Record<string, unknown>>();
    tb.onMessage(received.resolve);
    await ta.send({ $msg: { fromName: "root", body: { type: "PING" } } });
    expect(await received.promise).toEqual({ $msg: { fromName: "root", body: { type: "PING" } } });

    await ta.close();
    await tb.close();
  });

  it("enforces a single message handler", () => {
    const [a] = makePair();
    const t = new WorkerTransport(a);
    t.onMessage(() => {});
    expect(() => t.onMessage(() => {})).toThrow(/handler already set/);
  });

  it("removeHandler clears the handler", () => {
    const [a] = makePair();
    const t = new WorkerTransport(a);
    t.onMessage(() => {});
    expect(t.hasHandler).toBe(true);
    t.removeHandler();
    expect(t.hasHandler).toBe(false);
  });

  it("close terminates the worker and is idempotent", async () => {
    const [a] = makePair();
    const t = new WorkerTransport(a);
    await t.close();
    await t.close();
    expect(a.terminated).toBe(true);
    expect(t.canSend).toBe(false);
  });

  it("send after close throws", async () => {
    const [a] = makePair();
    const t = new WorkerTransport(a);
    await t.close();
    await expect(t.send({ $state: {} })).rejects.toThrow(/closed/);
  });

  it("fires onClose when the worker crashes", async () => {
    const [a] = makePair();
    const t = new WorkerTransport(a);

    const closed = makeWaiter<void>();
    t.onClose(closed.resolve);
    a.crash();
    await closed.promise;
    expect(t.canSend).toBe(false);
  });
});
