// ── remote module public surface (portable) ────────────────────────────────
//
// Everything here runs in a browser or service worker: no node: builtins, no
// Bun globals.  The node/bun-only pieces (FIFO transport + subprocess glue)
// live in ./node.js.

// seam
export { serveRemoteActor } from "./server.js";
export { makeSender } from "./sender.js";
export type { Spawner } from "./server.js";
export { remoteClient } from "./client.js";
export type { ClientSpawner } from "./client.js";

// what a process on the far side is, once it is not just a reference
export { RemoteProcess } from "./remote-process.js";
export type { FrameSink, RemoteMessage } from "./remote-process.js";
export { PROCESS_REF, ROOT_ID, isRemoteProcess } from "./process-ref.js";
export type { ProcessRef } from "./process-ref.js";

// frame vocabulary (shared, pure)
export type { Channel, StringTransport } from "./channel.js";
export { isProto, isInit, isState, isMsg, isExit, isStop, isPause, isResume } from "./channel.js";

// json1 protocol
export { VERSION, encode, decode, json1Channel } from "./protocols/json1.js";

// transports
export { WebSocketTransport, WS_OPEN, type WebSocketLike } from "./transports/websocket.js";
export { WorkerTransport, WORKER_VERSION, type WorkerLike } from "./transports/worker.js";

// spawners
export { wsClientSpawner, type WebSocketCtor } from "./spawners/ws-client.js";
export { wsServerSpawner, bunServerWebSocket, type BunServerWebSocketLike } from "./spawners/ws-server.js";
export { workerClientSpawner, type WorkerCtor } from "./spawners/worker-client.js";
export { workerSelfSpawner } from "./spawners/worker-self.js";
