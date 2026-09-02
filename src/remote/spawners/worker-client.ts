// ── Worker client spawner (command) ─────────────────────────────────────────────
//
// Environment-specific: spawns a Worker with the WHATWG `new Worker(url)` API,
// wraps it in a WorkerTransport, and returns a frame Channel with the $proto
// handshake already validated.

import { WorkerTransport, WORKER_VERSION, type WorkerLike } from "../transports/worker.js";
import { isProto } from "../channel.js";
import type { ClientSpawner } from "../client.js";

export type WorkerCtor = new (url: string) => WorkerLike;

const defaultWorker = (globalThis as { Worker?: WorkerCtor }).Worker;

export function workerClientSpawner<Args = unknown>(
  url: string | ((args: Args) => string),
  WorkerImpl: WorkerCtor = defaultWorker as WorkerCtor,
): ClientSpawner<Args> {
  return async (args) => {
    const target = typeof url === "function" ? url(args) : url;
    const channel = new WorkerTransport(new WorkerImpl(target));

    const protoFrame = await new Promise<Record<string, unknown>>((resolve) => {
      channel.onMessage((frame) => resolve(frame));
    });
    channel.removeHandler();

    if (!isProto(protoFrame) || protoFrame.$proto !== WORKER_VERSION) {
      throw new Error(`unsupported protocol: ${JSON.stringify(protoFrame).slice(0, 50)}`);
    }
    return channel;
  };
}
