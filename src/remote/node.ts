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

// the stdio wire: a newline-delimited channel over a stream pair, with the far
// end's own output carried as frames of its own
export {
  HANDSHAKE_TIMEOUT_MS,
  LineTransport,
  OutputFilter,
  StdioWireError,
  clientChannel,
  errorFrame,
  errorReason,
  fdStreams,
  outputFrame,
  parseOutputFrame,
  serverChannel,
  stderrSink,
} from "./stdio.js";
export type {
  ClientChannelOptions,
  LineStreams,
  OutputFd,
  OutputFrame,
  OutputSink,
} from "./stdio.js";

// the kit: how a payload is delivered to a host we know nothing about
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
export type { RemoteSpec, RemoteStaged, RemoteWayIn } from "./gateway-client.js";

// running one command on this host: staging is a command, the actor is another, and both
// are injectable so a test can do either without a sandbox, a host or a container
export { runHost, spawnChild } from "./host.js";
export type { HostResult, HostRun, SpawnChild } from "./host.js";

