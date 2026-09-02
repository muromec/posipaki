/* eslint-disable unicorn/prefer-add-event-listener */
// ── WebSocket client spawner ────────────────────────────────────────────────────
//
// Environment-specific: connects to a `ws://` URL with the WHATWG WebSocket,
// wraps it in a WebSocketTransport, and returns a frame Channel with the $proto
// handshake already validated.

import { WebSocketTransport } from "../transports/websocket.js";
import { json1Channel, VERSION } from "../protocols/json1.js";
import { isProto } from "../channel.js";
import type { ClientSpawner } from "../client.js";

export type WebSocketCtor = new (url: string) => {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
};

const defaultWebSocket = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;

function openWebSocket(ws: { readonly readyState: number; onopen: (() => void) | null; onerror: ((err: unknown) => void) | null }): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1 /* OPEN */) return resolve();
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(new Error(`websocket failed to open: ${String(err)}`));
  });
}

export function wsClientSpawner<Args = unknown>(
  url: string | ((args: Args) => string),
  WebSocketImpl: WebSocketCtor = defaultWebSocket as WebSocketCtor,
): ClientSpawner<Args> {
  return async (args) => {
    const target = typeof url === "function" ? url(args) : url;
    const ws = new WebSocketImpl(target);
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
