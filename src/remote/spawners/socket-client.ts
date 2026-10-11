// ── unix socket client spawner ─────────────────────────────────────────────
//
// Environment-specific: connects to a listening socket, wraps it in LineTransport, and returns a frame
// Channel with the `$proto` handshake already validated.

import { isProto, outputOf } from "../channel.js";
import type { ClientSpawner } from "../client.js";
import { json1Channel, VERSION } from "../protocols/json1.js";
import { connectUnixSocket, type UnixSocketClientOptions } from "../socket.js";
import { stderrSink, withOutput, type OutputSink } from "../output.js";

/** What a socket client needs: how to reach it, and where the far end's own output goes. */
export interface SocketClientSpawnerOptions extends UnixSocketClientOptions {
  /** Where the far end's own output goes.  Defaults to our stderr. */
  onOutput?: OutputSink;
}

export function socketClientSpawner<Args = unknown>(
  path: string | ((args: Args) => string),
  options: SocketClientSpawnerOptions = {},
): ClientSpawner<Args> {
  return async (args) => {
    const target = typeof path === "function" ? path(args) : path;
    const transport = await connectUnixSocket(target, options);
    const channel = json1Channel(transport);
    const sink = options.onOutput ?? stderrSink();

    // The waiter is set with no await between it and the connection: the transport starts reading as
    // soon as it is made, so a server that says `$proto` first thing would have it dropped otherwise.
    // A frame that is the far end's own print is not the protocol's, so it goes to the sink and the
    // wait carries on.
    const first = await new Promise<Record<string, unknown>>((resolve) => {
      const off = channel.onMessage((frame) => {
        const output = outputOf(frame);
        if (output) {
          sink(output.fd, output.data);
          return;
        }
        off();
        resolve(frame);
      });
    });
    if (!isProto(first) || first.$proto !== VERSION) {
      throw new Error(`unsupported protocol: ${JSON.stringify(first)}`);
    }
    return withOutput(channel, sink);
  };
}
