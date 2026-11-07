// ── unix socket client spawner ─────────────────────────────────────────────
//
// Environment-specific: connects to a listening socket and hands back the seam's frames over it.  The socket
// already frames its own lines, so what is left here is the connection and the agreement above it.

import type { ClientSpawner } from "../client.js";
import { seamOf } from "../seam.js";
import { connectUnixSocket, type UnixSocketClientOptions } from "../socket.js";

/** What a socket client needs: how to reach it. */
export interface SocketClientSpawnerOptions extends UnixSocketClientOptions {}

export function socketClientSpawner<Args = unknown>(
  path: string | ((args: Args) => string),
  options: SocketClientSpawnerOptions = {},
): ClientSpawner<Args> {
  return async (args) => {
    const target = typeof path === "function" ? path(args) : path;
    return seamOf(await connectUnixSocket(target, options), options);
  };
}
