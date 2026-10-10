// ── remote module public surface (portable) ────────────────────────────────
//
// Everything here runs in a browser or service worker: no node: builtins, no
// Bun globals.  The node/bun-only pieces (FIFO transport + subprocess glue)
// live in ./node.js.

// seam
export { serveRemoteActor } from "./reactor.js";
export { makeSender } from "./sender.js";
export type { Init, Served, Spawner, ServedProcess } from "./server.js";
export { CHANNEL_LOST, remoteClient } from "./client.js";
export type { ClientSpawner } from "./client.js";

// the server reactor: one loop for every medium, with the medium in a Listener
export { oneConnection, reactor } from "./reactor.js";
export type {
  AnyActorDefinition,
  Connection,
  Listener,
  Reactor,
  ReactorOptions,
  Session,
  SessionFactory,
} from "./reactor.js";

// what a process on the far side is, once it is not just a reference
export { RemoteProcess } from "./remote-process.js";
export type { FrameSink, RemoteMessage } from "./remote-process.js";
export { PROCESS_REF, rootIdFor, isRemoteProcess } from "./process-ref.js";
export type { ProcessRef } from "./process-ref.js";

// frame vocabulary (shared, pure)
export type { Channel, StringTransport } from "./channel.js";
export {
  isProto,
  isInit,
  isState,
  isMsg,
  isExit,
  isStop,
  isPause,
  isResume,
  isRelease,
} from "./channel.js";
// what a wire that could not be read says: unreadable frames never arrive as exceptions
export { BAD_PREFIX_LIMIT, badFrame, badReason, errorFrame, errorReason, isBad, isError } from "./channel.js";

// json1 protocol
export { VERSION, encode, decode, readFrame, json1Channel } from "./protocols/json1.js";

// transports
export { WebSocketTransport, WS_OPEN, type WebSocketLike } from "./transports/websocket.js";
export { WorkerTransport, WORKER_VERSION, type WorkerLike } from "./transports/worker.js";

// spawners
export {
  wsClientSpawner,
  type OpenedWebSocket,
  type WebSocketClientOptions,
  type WebSocketCtor,
  type WebSocketOpener,
} from "./spawners/ws-client.js";
export { wsServerSpawner, bunServerWebSocket, type BunServerWebSocketLike } from "./spawners/ws-server.js";
export { workerClientSpawner, type WorkerCtor } from "./spawners/worker-client.js";
export { workerSelfSpawner } from "./spawners/worker-self.js";
