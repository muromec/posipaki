/* eslint-disable unicorn/prefer-add-event-listener */
// ── WebSocket client spawner ────────────────────────────────────────────────────
//
// Environment-specific: connects to a `ws://` URL with the WHATWG WebSocket,
// wraps it in a WebSocketTransport, and returns a frame Channel with the $proto
// handshake already validated.
//
// What the socket is constructed with is the caller's: a token, an authority the machine does not
// already know, whatever that implementation accepts.  An option has nowhere else to go — the
// spawner is handed a URL and nothing else — and a token put in the URL is a token in every log the
// URL passes through.

import { WebSocketTransport } from "../transports/websocket.js";
import { json1Channel, VERSION } from "../protocols/json1.js";
import { isProto } from "../channel.js";
import type { ClientSpawner } from "../client.js";

/** What a WebSocket implementation is constructed with.  Passed through untouched. */
export type WebSocketOptions = Record<string, unknown>;

export type WebSocketCtor = new (
  url: string,
  options?: WebSocketOptions,
) => {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
};

/** How the socket is made: which implementation, and what it is constructed with. */
export interface WebSocketOpener {
  /** The implementation to construct.  The runtime's global `WebSocket` when it is not given. */
  WebSocket?: WebSocketCtor;
  /**
   * What it is constructed with — `{ headers }` to present a token, `{ tls: { ca } }` to trust a
   * certificate this machine does not know, whichever else that implementation accepts.
   *
   * A browser's WebSocket takes no options and can set no headers, so a client that must present
   * one is a program rather than a page.
   */
  options?: WebSocketOptions;
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
  open: WebSocketOpener = {},
): ClientSpawner<Args> {
  const WebSocketImpl = open.WebSocket ?? (defaultWebSocket as WebSocketCtor);
  return async (args) => {
    const target = typeof url === "function" ? url(args) : url;
    const ws = new WebSocketImpl(target, open.options);
    const transport = new WebSocketTransport(ws);
    const channel = json1Channel(transport);

    // Set the $proto waiter before awaiting open so a fast server's handshake
    // frame is not dropped.
    const protoPromise = new Promise<Record<string, unknown>>((resolve) => {
      channel.onMessage((frame) => resolve(frame));
    });
    await openWebSocket(ws);
    const protoFrame = await protoPromise;
    channel.removeHandler();

    if (!isProto(protoFrame) || protoFrame.$proto !== VERSION) {
      throw new Error(`unsupported protocol: ${JSON.stringify(protoFrame).slice(0, 50)}`);
    }
    return channel;
  };
}
