/* eslint-disable unicorn/prefer-add-event-listener */
// ── WebSocket spawner unit tests (in-memory fakes) ──────────────────────────────

import { describe, it, expect } from "vitest";
import { wsClientSpawner, type WebSocketCtor } from "./ws-client.js";
import { wsServerSpawner, bunServerWebSocket } from "./ws-server.js";
import { VERSION, decode } from "../protocols/json1.js";
import type { WebSocketLike } from "../transports/websocket.js";

class FakeClientWebSocket {
  static last: FakeClientWebSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeClientWebSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  openAndSend(frame: Record<string, unknown>): void {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const fakeCtor = FakeClientWebSocket as unknown as WebSocketCtor;

describe("wsClientSpawner", () => {
  it("connects, validates $proto, and returns a ready channel", async () => {
    const spawner = wsClientSpawner("ws://example.test/actor", fakeCtor);
    const channelPromise = spawner({ start: 0 });

    FakeClientWebSocket.last!.openAndSend({ $proto: VERSION });
    const channel = await channelPromise;

    expect(FakeClientWebSocket.last!.url).toBe("ws://example.test/actor");
    await channel.send({ $init: { start: 0, parentName: "x", parentIdName: "x" } });
    expect(FakeClientWebSocket.last!.sent).toContain(
      JSON.stringify({ $init: { start: 0, parentName: "x", parentIdName: "x" } }),
    );
  });

  it("resolves the url from spawn args when given a factory", async () => {
    const spawner = wsClientSpawner((args: { scope: string }) => `ws://h/counter/${args.scope}`, fakeCtor);
    const channelPromise = spawner({ scope: "abc" });
    FakeClientWebSocket.last!.openAndSend({ $proto: VERSION });
    await channelPromise;
    expect(FakeClientWebSocket.last!.url).toBe("ws://h/counter/abc");
  });

  it("rejects an unsupported protocol version", async () => {
    const spawner = wsClientSpawner("ws://x", fakeCtor);
    const channelPromise = spawner({});
    FakeClientWebSocket.last!.openAndSend({ $proto: "wrong.v1" });
    await expect(channelPromise).rejects.toThrow(/unsupported protocol/);
  });
});

describe("wsServerSpawner", () => {
  it("sends $proto and returns a ready channel", async () => {
    const sent: string[] = [];
    const ws: WebSocketLike = {
      send: (data) => sent.push(data),
      close: () => {},
      readyState: 1,
      onmessage: null,
      onclose: null,
    };

    const channel = await wsServerSpawner(ws)();
    expect(sent.map(decode)).toEqual([{ $proto: VERSION }]);

    await channel.send({ $init: { parentName: "x", parentIdName: "x" } });
    expect(sent.map(decode)[1]).toEqual({ $init: { parentName: "x", parentIdName: "x" } });
  });
});

describe("bunServerWebSocket", () => {
  it("adapts send/close and exposes settable message/close slots", () => {
    const sent: string[] = [];
    let closed = false;
    const adapter = bunServerWebSocket({
      send: (data) => sent.push(data),
      close: () => {
        closed = true;
      },
      readyState: 1,
    });

    adapter.send("hi");
    expect(sent).toEqual(["hi"]);
    adapter.close();
    expect(closed).toBe(true);

    const message = { data: "x" };
    let got = "";
    adapter.onmessage = (e) => {
      got = String(e.data);
    };
    adapter.onmessage?.(message);
    expect(got).toBe("x");
  });
});
