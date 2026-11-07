// ── WebSocket server spawner ────────────────────────────────────────────────────
//
// Environment-specific: serves an already-upgraded WebSocket connection.  The consumer's HTTP server does the
// upgrade and hands us the socket; we wrap it in a WebSocketTransport and compose the seam over it.

import { WebSocketTransport, type WebSocketLike } from "../transports/websocket.js";
import { seamOf } from "../seam.js";
import type { Spawner } from "../server.js";

export function wsServerSpawner(ws: WebSocketLike): Spawner {
  return async () => seamOf(new WebSocketTransport(ws));
}

/**
 * A minimal Bun `ServerWebSocket` — `send`/`close`/`readyState` plus the data
 * slot the server uses to stash per-connection state.  Bun delivers message and
 * close events through the `Bun.serve` websocket config callbacks, not through
 * properties on the socket, so the consumer routes them onto the adapter.
 */
export interface BunServerWebSocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  data?: unknown;
}

/**
 * Adapt a Bun server socket to the `WebSocketLike` the transport consumes.  The
 * returned adapter owns settable `onmessage`/`onclose` slots; the consumer
 * routes Bun's `message`/`close` config callbacks into them, e.g.:
 *
 * ```ts
 * Bun.serve({
 *   websocket: {
 *     open(ws) {
 *       const adapter = bunServerWebSocket(ws);
 *       ws.data = adapter;
 *       serveRemoteActor(actor, wsServerSpawner(adapter));
 *     },
 *     message(ws, msg) { (ws.data as WebSocketLike).onmessage?.({ data: msg }); },
 *     close(ws) { (ws.data as WebSocketLike).onclose?.(); },
 *   },
 * });
 * ```
 */
export function bunServerWebSocket(ws: BunServerWebSocketLike): WebSocketLike {
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    // Read through on every ask: a socket's state changes, and a snapshot taken at the upgrade would keep
    // saying "opening" for the life of the connection — which is a send that refuses forever.
    get readyState() {
      return ws.readyState;
    },
    onmessage: null,
    onclose: null,
  };
}
