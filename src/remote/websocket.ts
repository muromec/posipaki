// ── websockets: a listener over an HTTP server's upgrades ────────────────────
//
// A websocket as a medium for the reactor.  The consumer's HTTP server owns the socket, and the
// handshake is the WebSocket implementation's own step — with `ws`, or whatever the runtime ships —
// so this listener takes one thing from the consumer: the call that completes it.  Everything else
// here is the accept loop: which upgrade becomes a connection, who may present one, and what a
// refused one is told.  One upgrade is one connection, so there is nothing to keep between them.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { Connection, Listener } from "./reactor.js";
import { WebSocketTransport, type WebSocketLike } from "./transports/websocket.js";

/** What the far side is told when admission refuses it: not this door, and no handshake happened. */
const REFUSED = "HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n";

/** A server that reports an upgrade before answering it: node's `http`/`https` server. */
export interface UpgradeSource {
  on(event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

/** What arrived: the request that asked to upgrade, and the URL it asked for. */
export interface WebSocketUpgrade {
  readonly request: IncomingMessage;
  readonly url: URL;
}

export interface WebSocketListenerOptions<Meta = unknown> {
  /** The server whose upgrades become connections. */
  server: UpgradeSource;
  /**
   * Which path upgrades.  An upgrade on any other path is not this listener's and is left as it
   * arrived, so one server can route its paths between listeners.  Every path upgrades when it is
   * not given.
   */
  path?: string;
  /**
   * Admission and identity.  What it returns is the connection's meta; throwing refuses the upgrade
   * before any actor exists — a refused connection costs no actor and no channel — and the far side
   * is told by `refuse`.
   */
  identify?(upgrade: WebSocketUpgrade): Meta | Promise<Meta>;
  /**
   * Complete the handshake and answer with the socket: the WebSocket implementation's own step,
   * which is the one thing the library does not carry.  With `ws`:
   *
   * ```ts
   * upgrade: (request, socket, head) =>
   *   new Promise((resolve) => wss.handleUpgrade(request, socket, head, (ws) => resolve(socketOf(ws))))
   * ```
   */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<WebSocketLike>;
  /** What a refused upgrade is told.  Default: `401`, and the socket is closed. */
  refuse?(socket: Duplex, error: unknown, upgrade: WebSocketUpgrade): void;
}

/** An upgrade admission accepted, waiting for a connection to be taken from the queue. */
interface Admitted<Meta> {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  meta: Meta;
}

/**
 * Take connections from an HTTP server's upgrades, as the reactor's `Listener`.
 *
 * Admission happens when the upgrade arrives, so a refusal is the far side's before any handshake,
 * and the handshake happens when a connection is accepted: what the reactor is handed is an open
 * websocket and the meta it was admitted with.
 */
export function webSocketListener<Meta = unknown>(options: WebSocketListenerOptions<Meta>): Listener<Meta> {
  const { server, path } = options;
  /** Every socket this listener is responsible for: what it has taken, and what it is holding. */
  const held = new Set<Duplex>();
  const accepted: Admitted<Meta>[] = [];
  let waiting: { resolve: (admitted: Admitted<Meta>) => void; reject: (error: Error) => void } | null = null;
  let closed = false;
  // One admission at a time, in the order the upgrades arrived: an `identify` that waits would
  // otherwise let a later connection overtake an earlier one.
  let admitting: Promise<void> = Promise.resolve();

  const handshake = async (admitted: Admitted<Meta>): Promise<Connection<Meta>> => {
    const socket = await options.upgrade(admitted.request, admitted.socket, admitted.head);
    return { meta: admitted.meta, transport: new WebSocketTransport(socket) };
  };

  const take = (admitted: Admitted<Meta>): void => {
    held.add(admitted.socket);
    admitted.socket.once("close", () => held.delete(admitted.socket));
    const pending = waiting;
    waiting = null;
    if (pending) pending.resolve(admitted);
    else accepted.push(admitted);
  };

  const admit = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    } catch {
      // A request that cannot even be read as one is not one this listener can serve.
      socket.destroy();
      return;
    }
    if (path !== undefined && url.pathname !== path) return;
    const upgrade: WebSocketUpgrade = { request, url };
    let meta: Meta;
    try {
      meta = options.identify ? await options.identify(upgrade) : (undefined as Meta);
    } catch (error) {
      try {
        if (options.refuse) options.refuse(socket, error, upgrade);
        else socket.end(REFUSED);
      } catch {
        // A refusal hook that throws is still a refusal: the socket goes rather than the far side
        // waiting for an answer nobody is going to write.
        socket.destroy();
      }
      return;
    }
    // A far side that gave up while admission was being decided is nobody's to serve.
    if (closed || socket.destroyed) return;
    take({ request, socket, head, meta });
  };

  const arrived = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    admitting = admitting.then(() => admit(request, socket, head));
  };

  server.on("upgrade", arrived);

  const release = (error: Error): void => {
    const pending = waiting;
    waiting = null;
    pending?.reject(error);
  };

  return {
    accept(signal?: AbortSignal): Promise<Connection<Meta>> {
      if (closed) return Promise.reject(new Error("webSocketListener: closed"));
      const taken = accepted.shift();
      if (taken) return handshake(taken);
      return new Promise<Connection<Meta>>((resolve, reject) => {
        const mine = {
          resolve: (admitted: Admitted<Meta>) => {
            handshake(admitted).then(resolve, reject);
          },
          reject,
        };
        waiting = mine;
        signal?.addEventListener(
          "abort",
          () => {
            if (waiting === mine) waiting = null;
            reject(new Error("webSocketListener: stopped"));
          },
          { once: true },
        );
      });
    },
    async close(): Promise<void> {
      closed = true;
      server.off("upgrade", arrived);
      release(new Error("webSocketListener: closed"));
      // A connection this listener was given ends with it: the client learns that from its own socket
      // closing rather than from a handshake nobody is left to answer.
      for (const socket of held) socket.destroy();
      held.clear();
      accepted.length = 0;
    },
  };
}
