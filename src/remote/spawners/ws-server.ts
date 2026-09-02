// ── WebSocket server spawner ────────────────────────────────────────────────────
//
// Environment-specific: serves an already-upgraded WebSocket connection.  The
// consumer's HTTP server does the upgrade and hands us the socket; we wrap it in
// a WebSocketTransport, send $proto, and return the frame Channel.

import { WebSocketTransport, type WebSocketLike } from "../transports/websocket.js";
import { json1Channel, VERSION } from "../protocols/json1.js";
import type { Spawner } from "../server.js";

export function wsServerSpawner(ws: WebSocketLike): Spawner {
  return async () => {
    const channel = json1Channel(new WebSocketTransport(ws));
    await channel.send({ $proto: VERSION });
    return channel;
  };
}

/**
 * A minimal Bun `ServerWebSocket` — `send`/`close`/`readyState` plus the data
 * slot the server uses to stash per-connection state.  Bun delivers message and
 * close events through the `Bun.serve` websocket config callbacks, not through
 * properties on the socket, so the consumer routes them onto the adapter.
 */
export interface BunServerWebSocketLike {
  send(data: string): void;
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
    readyState: ws.readyState,
    onmessage: null,
    onclose: null,
  };
}
