/* eslint-disable unicorn/prefer-add-event-listener */
// ── WebSocket client spawner ────────────────────────────────────────────────────
//
// Environment-specific: connects to a `ws://` URL with the WHATWG WebSocket,
// wraps it in a WebSocketTransport, and returns a frame Channel with the $proto
// handshake already validated.
//
// How the socket is opened is the caller's.  The second parameter constructs one from a URL, which is
// what a runtime's own client takes; an opener replaces it with a function of the connection, which is
// where a header belongs — a token in a URL is a token in every log the URL passes through — and the
// only place a value that varies per spawn can be attached at all.

import { WebSocketTransport } from "../transports/websocket.js";
import { json1Channel, VERSION } from "../protocols/json1.js";
import { isProto } from "../channel.js";
import type { ClientSpawner } from "../client.js";

/** The socket the spawner needs: what the transport reads and writes, and the open/error slots. */
export type OpenedWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
};

export type WebSocketCtor = new (url: string) => OpenedWebSocket;

/**
 * How a socket is opened when a constructor is not enough: the URL to open, and the arguments this
 * spawn was called with.  A per-tenant header, a bearer token, an authority the machine does not
 * already know — each of them is a fact about the connection, and each of them is the caller's to
 * express in its own runtime's shape rather than in one posipaki was taught.
 */
export type WebSocketOpener<Args = unknown> = (url: string, args: Args) => OpenedWebSocket;

export interface WebSocketClientOptions<Args = unknown> {
  /** Opens the socket.  Given, it replaces the constructor. */
  open?: WebSocketOpener<Args>;
}

const defaultWebSocket = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;

/** What a socket failure says about itself.
 *
 * A WHATWG WebSocket reports an open failure as an ErrorEvent, and `String(event)` is
 * `[object ErrorEvent]`: its type, its message and the underlying error are all in its
 * own fields, so read those rather than stringify the event that carries them.
 */
function describeSocketError(err: unknown): string {
  if (typeof err !== "object" || err === null) return String(err);
  const event = err as { type?: unknown; message?: unknown; error?: unknown };
  const cause = event.error instanceof Error ? event.error.message : event.error;
  const parts = [event.type, event.message, cause].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(": ") : String(err);
}

function openWebSocket(ws: { readonly readyState: number; onopen: (() => void) | null; onerror: ((err: unknown) => void) | null }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1 /* OPEN */) return resolve();
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(new Error(`websocket failed to open: ${describeSocketError(err)}`));
  });
}

export function wsClientSpawner<Args = unknown>(
  url: string | ((args: Args) => string),
  WebSocketImpl: WebSocketCtor = defaultWebSocket as WebSocketCtor,
  opts: WebSocketClientOptions<Args> = {},
): ClientSpawner<Args> {
  // The constructor is the default opener, so the socket is opened one way either way.
  const open: WebSocketOpener<Args> = opts.open ?? ((target) => new WebSocketImpl(target));
  return async (args) => {
    const target = typeof url === "function" ? url(args) : url;
    const ws = open(target, args);
    const transport = new WebSocketTransport(ws);
    const channel = json1Channel(transport);

    // Set the $proto waiter before awaiting open so a fast server's handshake
    // frame is not dropped.
    const protoPromise = new Promise<Record<string, unknown>>((resolve) => {
      const off = channel.onMessage((frame) => {
        off();
        resolve(frame);
      });
    });
    await openWebSocket(ws);
    const protoFrame = await protoPromise;

    if (!isProto(protoFrame) || protoFrame.$proto !== VERSION) {
      throw new Error(`unsupported protocol: ${JSON.stringify(protoFrame).slice(0, 50)}`);
    }
    return channel;
  };
}
