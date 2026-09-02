// ── Worker server spawner (self) ────────────────────────────────────────────────
//
// Environment-specific: serves the worker-global scope (`self`) as a frame
// Channel with the $proto handshake already sent.  The worker entry script calls
// `serveRemoteActor(actor, workerSelfSpawner())`.

import { WorkerTransport, WORKER_VERSION, type WorkerLike } from "../transports/worker.js";
import type { Spawner } from "../server.js";

export function workerSelfSpawner(selfScope: WorkerLike = globalThis as unknown as WorkerLike): Spawner {
  return async () => {
    const channel = new WorkerTransport(selfScope);
    await channel.send({ $proto: WORKER_VERSION });
    return channel;
  };
}
