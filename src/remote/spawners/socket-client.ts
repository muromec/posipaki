// ── unix socket client spawner ─────────────────────────────────────────────
//
// Environment-specific: connects to a listening socket, wraps it in LineTransport, and returns a frame
// Channel with the `$proto` handshake already validated.

import { isProto } from "../channel.js";
import type { ClientSpawner } from "../client.js";
import { json1Channel, VERSION } from "../protocols/json1.js";
import { connectUnixSocket, type UnixSocketClientOptions } from "../socket.js";

export function socketClientSpawner<Args = unknown>(
  path: string | ((args: Args) => string),
  options: UnixSocketClientOptions = {},
): ClientSpawner<Args> {
  return async (args) => {
    const target = typeof path === "function" ? path(args) : path;
    const transport = await connectUnixSocket(target, options);
    const channel = json1Channel(transport);

    // The waiter is set with no await between it and the connection: the transport starts reading as
    // soon as it is made, so a server that says `$proto` first thing would have it dropped otherwise.
    const first = await new Promise<Record<string, unknown>>((resolve) => {
      channel.onMessage((frame) => resolve(frame));
    });
    channel.removeHandler();
    if (!isProto(first) || first.$proto !== VERSION) {
      throw new Error(`unsupported protocol: ${JSON.stringify(first)}`);
    }
    return channel;
  };
}
