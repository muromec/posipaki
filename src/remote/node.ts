// ── remote module: node/bun surface ─────────────────────────────────────────────
//
// The node/bun-only pieces of the remote seam: the stdio wire, the FIFO
// transport, its two spawners, and the subprocess glue.  Importing this from a
// browser is a mistake — it pulls in node:fs / node:child_process /
// node:readline.  The portable seam lives in ./index.js.

export { FifoUtf8NlineTransport } from "./transports/fifo.js";
export { commandSpawner } from "./spawners/fifo-command.js";
export { fifoArgvSpawner } from "./spawners/fifo-argv.js";
export { defineSubprocessActor } from "./define-subprocess.js";
export type { SubprocessActorOptions, SubprocessActorBundle } from "./define-subprocess.js";

// the stdio wire: a newline-delimited channel over a stream pair, with the far end's own output carried
// as frames of its own
export {
  HANDSHAKE_TIMEOUT_MS,
  LineTransport,
  StdioWireError,
  clientChannel,
  errorFrame,
  errorReason,
  fdStreams,
  serverChannel,
} from "./stdio.js";
export { pumpOutput, stderrSink } from "./output.js";
export type { OutputSink } from "./output.js";

// the connection as streams: what each end's root prints, and what it reads
export { logStream } from "./streams.js";
export type { LineLog } from "./streams.js";
export type { ClientChannelOptions, LineStreams } from "./stdio.js";
export {
  DEFAULT_KIT_PARENT,
  DEFAULT_RUNTIMES,
  GATEWAY_ARTIFACT,
  KIT_LAYOUT,
  PAYLOAD_ARTIFACT,
  PAYLOAD_REFUSED,
  HostVersionError,
  bootstrapScript,
  hostVersion,
  hostVersionAccepts,
  kitVersion,
  makeKit,
  parseBootstrapReport,
  parseHostVersion,
  sameHostVersion,
  sha256Hex,
} from "./kit.js";
export type {
  BootstrapReport,
  HostVersion,
  HostVersionVerdict,
  Kit,
  KitApp,
  KitFile,
  MakeKitOptions,
} from "./kit.js";

// the gateway: the first-stage command that relays to a payload inside an
// environment, over the one channel every way in gives us
export { GATEWAY_FAILED, gatewayArgs, gatewayBoot, runGateway } from "./gateway.js";
export type { GatewayBoot } from "./gateway.js";

// the client side of that gateway: what every way in hands its two things to — where the
// payload is, and which build it is — and gets a spawner back.  A way in supplies the
// entry, the one function that says how a command runs there.
export { GATEWAY_ENTRY, RemoteSpecError, gatewayClient, hostRemote } from "./gateway-client.js";
export type { HostProgram, RemoteSpec, RemoteWayIn } from "./gateway-client.js";

// running one command on this host: staging is a command, the actor is another, and both
// are injectable so a test can do either without a sandbox, a host or a container
export { runHost, spawnChild } from "./host.js";
export type { HostResult, HostRun, SpawnChild } from "./host.js";


// the unix socket: a listener the reactor takes connections from, and a client for anyone who wants one
export { connectUnixSocket, unixSocketListener } from "./socket.js";
export type { UnixSocketClientOptions, UnixSocketListenerOptions, UnixSocketPeer } from "./socket.js";
export { socketClientSpawner } from "./spawners/socket-client.js";
export type { SocketClientSpawnerOptions } from "./spawners/socket-client.js";

// a fifo pair: a listener for the reactor, and a client for whoever holds the other end
export { fifoClientSpawner, fifoListener, makeFifoPair } from "./fifo.js";
export type { FifoListenerOptions, FifoPair } from "./fifo.js";

// the websocket listener: an HTTP server's upgrades, taken in order, with admission before the handshake
export { webSocketListener } from "./websocket.js";
export type { UpgradeSource, WebSocketListenerOptions, WebSocketUpgrade } from "./websocket.js";
