/* eslint-disable unicorn/prefer-add-event-listener */
// ── WebSocket transport ─────────────────────────────────────────────────────────
//
// Message-boundary transport over a WebSocket.  The socket's native framing means
// one `send` is one frame — there is no delimiter to add or strip.  It moves
// encoded frames (strings); json1Channel sits above it and handles JSON.

import type { StringTransport } from "../channel.js";

/**
 * The subset of a WebSocket the transport needs.  The WHATWG client WebSocket
 * (Node, Bun, browsers) satisfies this directly; a Bun server socket is adapted
 * by the consumer (see spawners/ws-server.ts).
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

/** WHATWG WebSocket readyState: OPEN. */
export const WS_OPEN = 1;

export class WebSocketTransport implements StringTransport {
  private ws: WebSocketLike;
  private pvtOnMessage: ((frame: string) => void) | null = null;
  private pvtOnClose: (() => void) | null = null;
  private closed = false;

  constructor(ws: WebSocketLike) {
    this.ws = ws;
    ws.onmessage = (event) => {
      if (this.pvtOnMessage && !this.closed) this.pvtOnMessage(String(event.data));
    };
    ws.onclose = () => {
      this.closed = true;
      this.pvtOnClose?.();
    };
  }

  get canSend(): boolean {
    return !this.closed && this.ws.readyState === WS_OPEN;
  }

  onMessage(handler: (frame: string) => void): void {
    if (this.closed) throw new Error("WebSocketTransport: closed");
    if (this.pvtOnMessage !== null) {
      throw new Error("WebSocketTransport: handler already set — call removeHandler() first");
    }
    this.pvtOnMessage = handler;
  }

  removeHandler(): ((frame: string) => void) | null {
    const prev = this.pvtOnMessage;
    this.pvtOnMessage = null;
    return prev;
  }

  onClose(handler: () => void): void {
    this.pvtOnClose = handler;
  }

  get hasHandler(): boolean {
    return this.pvtOnMessage !== null;
  }

  async send(frame: string): Promise<void> {
    if (this.closed) throw new Error("WebSocketTransport: closed");
    if (this.ws.readyState !== WS_OPEN) throw new Error("WebSocketTransport: not open");
    this.ws.send(frame);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // already closing / closed — ignore
    }
  }
}
