// ── remote module public surface ───────────────────────────────────────────

// seam
export { serveRemoteActor, makeSender } from "./server.js";
export type { Spawner } from "./server.js";
export { remoteClient } from "./client.js";
export type { ClientSpawner } from "./client.js";

// frame vocabulary (shared, pure)
export type { Channel, StringTransport } from "./channel.js";
export { isProto, isInit, isState, isMsg, isExit } from "./channel.js";

// json1 protocol
export { VERSION, encode, decode, json1Channel } from "./protocols/json1.js";

// transports
export { FifoUtf8NlineTransport } from "./transports/fifo.js";
export { WebSocketTransport, WS_OPEN, type WebSocketLike } from "./transports/websocket.js";
export { WorkerTransport, WORKER_VERSION, type WorkerLike } from "./transports/worker.js";

// spawners
export { commandSpawner } from "./spawners/fifo-command.js";
export { fifoArgvSpawner } from "./spawners/fifo-argv.js";
export { wsClientSpawner, type WebSocketCtor } from "./spawners/ws-client.js";
export { wsServerSpawner, bunServerWebSocket, type BunServerWebSocketLike } from "./spawners/ws-server.js";
export { workerClientSpawner, type WorkerCtor } from "./spawners/worker-client.js";
export { workerSelfSpawner } from "./spawners/worker-self.js";

// subprocess glue
export { defineSubprocessActor } from "./define-subprocess.js";
export type { SubprocessActorOptions, SubprocessActorBundle } from "./define-subprocess.js";
