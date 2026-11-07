/* eslint-disable unicorn/prefer-add-event-listener */
// ── WebSocket client spawner ────────────────────────────────────────────────────
//
// Connects to a `ws://` URL with the WHATWG WebSocket and returns the seam's frames over it.  The socket must be
// open before `$proto` can be sent, so the seam is composed first and its announcement waits for the open.
//
// How the socket is opened is the caller's: the second parameter constructs one from a URL, and an opener
// replaces that with a function of the connection, which is where a header belongs.  A token in a URL is a token
// in every log that URL passes through.

import { WebSocketTransport } from "../transports/websocket.js";
import { seamOf } from "../seam.js";
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
    // The seam is composed before the socket opens — its reader is installed synchronously — and the
    // announcement waits for the open, because a socket that is still connecting cannot carry it.
    const opened = openWebSocket(ws);
    const seam = seamOf(transport, { ready: opened });
    try {
      await opened;
    } catch (error) {
      // The seam refuses for the same reason; the open failure is the one worth naming, so it is the one
      // that leaves here and the other is not left unhandled.
      void seam.catch(() => undefined);
      throw error;
    }
    return seam;
  };
}
