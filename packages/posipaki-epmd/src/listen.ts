// ── a node that accepts connections ─────────────────────────────────────────
//
// The other role of the same protocol: a socket arrives, the handshake runs with this side accepting, and what is
// left is a channel of messages the caller owns. Every connection has its own handshake and its own channel; the
// cookie is all they share.

import { createServer, type Server, type Socket } from "node:net";

import type { Channel } from "posipaki/port";
import { streamChannel } from "posipaki/port";

import { wrapEpmdFrame } from "./frame.js";
import { accept, DEFAULT_TIMEOUT_MS, MANDATORY_FLAGS, type Peer } from "./handshake.js";
import { withMeaning, type WireMessage } from "./messages.js";

export interface ListenOptions {
  /** The name this node answers to. */
  readonly self: string;
  readonly cookie: string;
  /** This node's incarnation, which every pid it writes carries. */
  readonly creation: number;
  /** The flags this node offers. Default: the mandatory set. */
  readonly flags?: readonly [high: number, low: number];
  readonly timeoutMs?: number;
  /** The interface to bind. Default `0.0.0.0`, because a node that only listens on loopback is not reachable. */
  readonly host?: string;
  /** The port to listen on. Default 0, which lets the OS pick one. */
  readonly port?: number;
}

/** What a connection is handed to. */
export interface ListenerHandlers {
  /** A connection whose handshake was proved, and the channel it carries. */
  onConnection(peer: Peer, messages: Channel<WireMessage>): void;
  /** A connection this side refused: the cookie was wrong, or the wire was not what it should be. */
  onRefused?(error: Error): void;
}

/** A node that is listening. */
export interface Listener {
  /** The port it is listening on. */
  readonly port: number;
  close(): Promise<void>;
}

/** A node that accepts connections, and proves the cookie on each of them before handing it over. */
export async function listen(options: ListenOptions, handlers: ListenerHandlers): Promise<Listener> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const frames = wrapEpmdFrame(streamChannel({ read: socket, write: socket }));
    const messages = withMeaning(frames, "acceptor");
    void accept(
      { frames, messages },
      {
        self: options.self,
        cookie: options.cookie,
        creation: options.creation,
        flags: options.flags ?? MANDATORY_FLAGS,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
    ).then(
      (peer) => handlers.onConnection(peer, messages),
      (error: unknown) => {
        handlers.onRefused?.(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
      },
    );
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 0, options.host ?? "0.0.0.0", () => {
      const address = server.address();
      resolve(address === null || typeof address === "string" ? (options.port ?? 0) : address.port);
    });
  });

  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
