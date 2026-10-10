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

  it("names what a failed open was, rather than the event that carried it", async () => {
    // A WHATWG WebSocket reports an open failure as an ErrorEvent, and `String(event)`
    // is `[object ErrorEvent]`: every field that says what happened is dropped by
    // stringifying it (2026-10-01 — 24 such lines in forty minutes, nothing to act on).
    class FailingClientWebSocket extends FakeClientWebSocket {
      constructor(url: string) {
        super(url);
        queueMicrotask(() =>
          this.onerror?.({
            type: "error",
            message: "",
            error: new Error("connect ECONNREFUSED 127.0.0.1:1"),
          }),
        );
      }
    }

    const spawner = wsClientSpawner(
      "ws://127.0.0.1:1/actor",
      FailingClientWebSocket as unknown as WebSocketCtor,
    );

    await expect(spawner({})).rejects.toThrow(/ECONNREFUSED/);
  });

  it("opens the socket with the caller's opener, which sees the spawn args", async () => {
    // A token belongs in a header rather than in the URL, which is what logs carry, and a value that
    // varies per spawn needs the args: neither is expressible through a constructor alone.
    const opened: Array<{ url: string; tenant: string }> = [];
    const spawner = wsClientSpawner<{ tenant: string }>("ws://service.test/voice", undefined, {
      open: (url, args) => {
        opened.push({ url, tenant: args.tenant });
        return new FakeClientWebSocket(url);
      },
    });

    const channelPromise = spawner({ tenant: "acme" });
    FakeClientWebSocket.last!.openAndSend({ $proto: VERSION });
    await channelPromise;

    expect(opened).toEqual([{ url: "ws://service.test/voice", tenant: "acme" }]);
    // Everything above the socket is unchanged: the $proto handshake is still read through it.
    expect(FakeClientWebSocket.last!.url).toBe("ws://service.test/voice");
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
