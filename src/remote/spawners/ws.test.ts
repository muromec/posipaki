/* eslint-disable unicorn/prefer-add-event-listener */
// ── WebSocket spawner unit tests (in-memory fakes) ──────────────────────────────

import { describe, it, expect } from "vitest";
import { wsClientSpawner, type WebSocketCtor } from "./ws-client.js";
import { wsServerSpawner, bunServerWebSocket, nodeServerWebSocket } from "./ws-server.js";
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
    // On a later turn, because that is when a message arrives: the spawner composes the seam once the socket
    // is open, and a frame handed over in the same breath would precede its reader.
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(frame) }));
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
    await expect(channelPromise).rejects.toThrow(
      "the far end speaks wrong.v1, and this side speaks json.v1",
    );
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

/** What a message was, for an assertion about lines: the text, or a marker that fails the
 *  comparison when octets were sent where a case expected a line. */
function asText(data: string | Uint8Array): string {
  return typeof data === "string" ? data : `<${data.length} octets>`;
}

describe("wsServerSpawner", () => {
  it("announces, and hands back the seam once the far side has spoken", async () => {
    const sent: Array<string | Uint8Array> = [];
    const ws: WebSocketLike = {
      send: (data) => sent.push(data),
      close: () => {},
      readyState: 1,
      onmessage: null,
      onclose: null,
    };

    const spawning = wsServerSpawner(ws)();
    // Both ends announce: the far side's word is what the seam waits for before it hands the channel over.
    await Promise.resolve();
    ws.onmessage?.({ data: JSON.stringify({ $proto: VERSION }) });
    const channel = await spawning;
    expect(sent.map(asText).map(decode)).toEqual([{ $proto: VERSION }]);

    await channel.send({ $init: { parentName: "x", parentIdName: "x" } });
    expect(sent.map(asText).map(decode)[1]).toEqual({ $init: { parentName: "x", parentIdName: "x" } });
  });
});

describe("bunServerWebSocket", () => {
  it("adapts send/close and exposes settable message/close slots", () => {
    const sent: Array<string | Uint8Array> = [];
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

describe("nodeServerWebSocket", () => {
  it("adapts a ws socket whose events arrive as listeners, and ends once", () => {
    const listeners = new Map<string, (payload?: unknown) => void>();
    const sent: Array<string | Uint8Array> = [];
    let closed = false;
    const adapter = nodeServerWebSocket({
      send: (data) => sent.push(data),
      close: () => {
        closed = true;
      },
      readyState: 1,
      on(event, handler) {
        listeners.set(event, handler as (payload?: unknown) => void);
        return this;
      },
    });

    adapter.send("hi");
    adapter.close();
    expect(sent).toEqual(["hi"]);
    expect(closed).toBe(true);

    let said = "";
    let endings = 0;
    adapter.onmessage = (event) => {
      said = String(event.data);
    };
    adapter.onclose = () => {
      endings += 1;
    };

    listeners.get("message")?.("hello");
    // An error and the close that follows it are one ending, not two.
    listeners.get("error")?.(new Error("boom"));
    listeners.get("close")?.();

    expect(said).toBe("hello");
    expect(endings).toBe(1);
  });

  it("hands a text frame back as text, and a binary one as bytes", () => {
    // `ws` gives a Buffer for both and puts the distinction in the second argument; a text frame passed on as
    // bytes is a line the transport never terminates, so nothing above the adapter ever reads a frame.
    const box: { heard: ((data: unknown, isBinary: boolean) => void) | null } = { heard: null };
    const adapter = nodeServerWebSocket({
      send: () => {},
      close: () => {},
      readyState: 1,
      on(event, handler) {
        if (event === "message") box.heard = handler as (data: unknown, isBinary: boolean) => void;
        return this;
      },
    });
    const seen: unknown[] = [];
    adapter.onmessage = (event) => seen.push(event.data);

    box.heard?.(Buffer.from("a line"), false);
    box.heard?.(Buffer.from([1, 2]), true);

    expect(seen[0]).toBe("a line");
    expect(Buffer.from(seen[1] as Uint8Array)).toEqual(Buffer.from([1, 2]));
  });
});
