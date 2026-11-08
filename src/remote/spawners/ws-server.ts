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

/** The `ws` package's server-side socket, as little of it as is used here. */
export interface NodeServerWebSocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  on(event: "message", handler: (data: unknown) => void): unknown;
  on(event: "close", handler: () => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
}

/**
 * Adapt a node `ws` socket to the `WebSocketLike` the transport consumes.
 *
 * The difference from Bun's is who delivers the events: `ws` hands them to listeners on the socket itself, so the
 * adapter subscribes once and routes them onto the settable slots.  An error ends the connection the way a close
 * does — the transport hears one ending, not two.
 *
 * ```ts
 * server.on("upgrade", (request, socket, head) => {
 *   wss.handleUpgrade(request, socket, head, (ws) => {
 *     serveRemoteActor(actor, wsServerSpawner(nodeServerWebSocket(ws)));
 *   });
 * });
 * ```
 */
export function nodeServerWebSocket(ws: NodeServerWebSocketLike): WebSocketLike {
  const adapter: WebSocketLike = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    // Read through on every ask, for the same reason as Bun's: a snapshot keeps saying "opening".
    get readyState() {
      return ws.readyState;
    },
    onmessage: null,
    onclose: null,
  };
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    adapter.onclose?.();
  };
  ws.on("message", (data) => adapter.onmessage?.({ data }));
  ws.on("close", finish);
  ws.on("error", finish);
  return adapter;
}
