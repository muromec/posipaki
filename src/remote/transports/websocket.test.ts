// ── WebSocketTransport tests (in-memory fake socket pair) ───────────────────────

import { describe, it, expect } from "vitest";
import { WebSocketTransport, WS_OPEN, type WebSocketLike } from "./websocket.js";
import { makeWaiter } from "../../util.js";

class FakeSocket implements WebSocketLike {
  peer: FakeSocket | null = null;
  readyState = WS_OPEN;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  send(data: string): void {
    if (this.closed) throw new Error("send on closed socket");
    this.peer?.deliver(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.peer?.peerClosed();
  }
  deliver(data: string): void {
    this.onmessage?.({ data });
  }
  peerClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
}

function makePair(): [FakeSocket, FakeSocket] {
  const a = new FakeSocket();
  const b = new FakeSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe("WebSocketTransport", () => {
  it("moves a frame from one socket to the other", async () => {
    const [a, b] = makePair();
    const ta = new WebSocketTransport(a);
    const tb = new WebSocketTransport(b);

    const received = makeWaiter<string>();
    tb.onMessage(received.resolve);
    await ta.send("hello");
    expect(await received.promise).toBe("hello");

    await ta.close();
    await tb.close();
  });

  it("delivers frames in order", async () => {
    const [a, b] = makePair();
    const ta = new WebSocketTransport(a);
    const tb = new WebSocketTransport(b);

    const buffer: string[] = [];
    const received = makeWaiter<string[]>();
    tb.onMessage((frame) => {
      buffer.push(frame);
      if (buffer.length === 3) received.resolve(buffer);
    });

    await ta.send("1");
    await ta.send("2");
    await ta.send("3");
    expect(await received.promise).toEqual(["1", "2", "3"]);

    await ta.close();
    await tb.close();
  });

  it("enforces a single message handler", () => {
    const [a] = makePair();
    const t = new WebSocketTransport(a);
    t.onMessage(() => {});
    expect(() => t.onMessage(() => {})).toThrow(/handler already set/);
  });

  it("removeHandler clears the handler", () => {
    const [a] = makePair();
    const t = new WebSocketTransport(a);
    t.onMessage(() => {});
    expect(t.hasHandler).toBe(true);
    t.removeHandler();
    expect(t.hasHandler).toBe(false);
  });

  it("close is idempotent and marks the transport closed", async () => {
    const [a] = makePair();
    const t = new WebSocketTransport(a);
    await t.close();
    await t.close();
    expect(t.canSend).toBe(false);
  });

  it("send after close throws", async () => {
    const [a] = makePair();
    const t = new WebSocketTransport(a);
    await t.close();
    await expect(t.send("late")).rejects.toThrow(/closed/);
  });

  it("fires onClose when the peer closes", async () => {
    const [a, b] = makePair();
    const ta = new WebSocketTransport(a);
    const tb = new WebSocketTransport(b);

    const closed = makeWaiter<void>();
    tb.onClose(closed.resolve);
    await ta.close();
    await closed.promise;
    expect(tb.canSend).toBe(false);
  });
});
