// ── posipaki-epmd ───────────────────────────────────────────────────────────
//
// Talk to an Erlang node over its own distribution protocol. Bottom up: `frame` cuts packets by the length they
// announce, `terms` reads and writes BEAM terms, `control` names the control message a distribution message carries,
// `messages` says what a frame is, `handshake` proves the cookie from either side, `epmd` is the port mapper at both
// ends, `connection` and `listen` are the two roles of a connection, `cluster` is the table of the nodes this runtime
// can reach — and of the pids its own processes answer at, and `node` is this side as a node: a listener, a
// registration, and the processes it serves.
//
// Two actors sit on top: `proxy` stands for a process on another node, and a served process is handed a term as
// `ETF_RAW` and answers with one.
//
// The demos are in `demo/`: they are the only things here that decide anything about a command line.

export { wrapEpmdFrame, type EpmdFrame, type Framed, type Prefix } from "./frame.js";

export {
  atom,
  binary,
  integer,
  list,
  map,
  pid,
  render,
  TermReader,
  tuple,
  write,
  type Term,
} from "./terms.js";

export { readControl, writeControl, type Control } from "./control.js";

export { decode, encode, inbox, withMeaning, type Side, type WireMessage } from "./messages.js";

export {
  accept,
  DEFAULT_TIMEOUT_MS,
  digest,
  initiate,
  MANDATORY_FLAGS,
  type HandshakeOptions,
  type HandshakePorts,
  type Peer,
} from "./handshake.js";

export { epmdPort, epmdRegister, serveEpmd, type Lookup, type Mapper, type Registration } from "./epmd.js";

export { connect, open, type Connection, type ConnectionOptions } from "./connection.js";

export { listen, type Listener, type ListenerHandlers, type ListenOptions } from "./listen.js";

export {
  clusterNamed,
  DEFAULT_CLUSTER,
  forgetCluster,
  installCluster,
  makeCluster,
  nodeName,
  nodeRef,
  refFromName,
  refOf,
  type Cluster,
  type ClusterOptions,
  type NodeRef,
  type PidTerm,
  type ProcessHandle,
} from "./cluster.js";

export {
  forHere,
  forWire,
  processTerm,
  remoteTerm,
  show,
  type LocalProcess,
  type RemoteInTerm,
  type RemoteProcess,
  type VisibleTerm,
} from "./processes.js";

export { ErlangProxy, samePid, type EtfRaw, type ProxyArgs } from "./proxy.js";

export {
  startNode,
  type ErlangNode,
  type EtfAnswered,
  type EtfAsked,
  type NodeFacts,
  type NodeOptions,
  type ServedProcess,
} from "./node.js";

export { withTimeout } from "./timeout.js";
