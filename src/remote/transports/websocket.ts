/* eslint-disable unicorn/prefer-add-event-listener */
// ── WebSocket transport ─────────────────────────────────────────────────────────
//
// Message-boundary transport over a WebSocket.  The socket's native framing means
// one `send` is one message — there is no delimiter to add or strip — so a line
// travels as a text message and the octets a line announces travel as a binary one.
// Both ends feed what they receive through the same reader a stream carrier uses,
// which is why a websocket and a fifo are the same wire above this point.

import { PartReader } from "../lines.js";
import type { StringTransport } from "../channel.js";

/**
 * The subset of a WebSocket the transport needs.  The WHATWG client WebSocket
 * (Node, Bun, browsers) satisfies this directly; a Bun server socket is adapted
 * by the consumer (see spawners/ws-server.ts).
 */
export interface WebSocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

/** WHATWG WebSocket readyState: OPEN. */
export const WS_OPEN = 1;

const encoder = new TextEncoder();

/** The octets a message carried, whatever the socket hands over. */
function octetsOf(data: unknown): Uint8Array | null {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export class WebSocketTransport implements StringTransport {
  private ws: WebSocketLike;
  private pvtOnMessage: ((frame: string) => number | void) | null = null;
  private pvtOnBytes: ((bytes: Uint8Array) => void) | null = null;
  private pvtOnClose: (() => void) | null = null;
  private closed = false;
  private readonly reader: PartReader;

  constructor(ws: WebSocketLike) {
    this.ws = ws;
    this.reader = new PartReader(
      (line) => (this.closed ? undefined : this.pvtOnMessage?.(line)),
      (bytes) => {
        if (!this.closed) this.pvtOnBytes?.(bytes);
      },
    );
    ws.onmessage = (event) => {
      if (this.closed) return;
      // A text message is a line, and the reader wants it ended the way a line ends on a
      // stream; a binary message is the octets a line announced.
      if (typeof event.data === "string") this.reader.feed(encoder.encode(`${event.data}\n`));
      else {
        const bytes = octetsOf(event.data);
        if (bytes) this.reader.feed(bytes);
      }
    };
    ws.onclose = () => {
      this.closed = true;
      this.reader.end();
      this.pvtOnClose?.();
    };
  }

  get canSend(): boolean {
    return !this.closed && this.ws.readyState === WS_OPEN;
  }

  onMessage(handler: (frame: string) => number | void): void {
    if (this.closed) throw new Error("WebSocketTransport: closed");
    if (this.pvtOnMessage !== null) {
      throw new Error("WebSocketTransport: handler already set — call removeHandler() first");
    }
    this.pvtOnMessage = handler;
  }

  onBytes(handler: (bytes: Uint8Array) => void): void {
    if (this.closed) throw new Error("WebSocketTransport: closed");
    this.pvtOnBytes = handler;
  }

  removeHandler(): ((frame: string) => number | void) | null {
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

  async sendBytes(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("WebSocketTransport: closed");
    if (this.ws.readyState !== WS_OPEN) throw new Error("WebSocketTransport: not open");
    this.ws.send(bytes);
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
