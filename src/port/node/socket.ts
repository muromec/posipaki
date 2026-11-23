// ── a TCP connection as a channel of bytes ──────────────────────────────────
//
// The far end is a socket: frames arrive as the peer writes them, `send` writes, and the ending is the peer's or
// the wire's.  What the bytes mean is above this — a length prefix, a line, a protocol.
//
// The connection is made before the channel exists, so an address nothing answers is a rejected promise naming
// it rather than a channel that fails on its first frame.

import { connect, type Socket } from "node:net";

import type { Channel } from "../channel.js";
import { streamChannel } from "../stream.js";

export interface SocketOptions {
  host: string;
  port: number;
  /** How long the connection may take.  Default 10 000 ms. */
  connectMs?: number;
}

const DEFAULT_CONNECT_MS = 10_000;

/** A TCP connection as a channel of bytes. */
export function socketChannel(options: SocketOptions): Promise<Channel<Uint8Array>> {
  const where = `${options.host}:${options.port}`;
  const socket = connect({ host: options.host, port: options.port });
  return connected(socket, where, options.connectMs ?? DEFAULT_CONNECT_MS).then(() =>
    streamChannel({ read: socket, write: socket }),
  );
}

/** Settles once the socket is connected, or with what went wrong, named by its address. */
function connected(socket: Socket, where: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fail = (error: Error): void => {
      if (timer !== null) clearTimeout(timer);
      socket.destroy();
      reject(new Error(`socketChannel: ${where}: ${error.message}`));
    };
    timer = setTimeout(() => fail(new Error(`no connection within ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
    // Kept after the connection is made: an error later is the channel's ending, and a settled promise ignores it.
    socket.once("error", fail);
    socket.once("connect", () => {
      if (timer !== null) clearTimeout(timer);
      resolve();
    });
  });
}
