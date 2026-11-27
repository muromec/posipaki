// ── posipaki-epmd ───────────────────────────────────────────────────────────
//
// Talk to an Erlang node over its own distribution protocol. Bottom up: `frame` cuts packets by the length they
// announce, `terms` reads and writes BEAM terms, `control` names the control message a distribution message carries,
// `messages` says what a frame is, `handshake` proves the cookie from either side, `epmd` is the port mapper at both
// ends, `connection` and `listen` are the two roles of a connection, `cluster` is the configuration a node runs from and
// the grammar of a node's name, and `node` is this side as a node: a listener, a registration, the processes it serves
// and the peers it reaches.
//
// Two actors sit on top: `actor` stands for a process on another node, and a served process is handed a term as
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

export {
  epmdPort,
  epmdRegister,
  mapperAnswers,
  MapperPortTaken,
  serveEpmd,
  type Lookup,
  type Mapper,
  type Registration,
} from "./epmd.js";

export { connect, open, type Connection, type ConnectionOptions } from "./connection.js";

export { listen, type Listener, type ListenerHandlers, type ListenOptions } from "./listen.js";

export {
  DEFAULT_CLUSTER,
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
  type Watch,
} from "./cluster.js";

export {
  forHere,
  forWire,
  processTerm,
  remoteTerm,
  show,
  type LocalProcess,
  type RemoteInTerm,
  type ErlangProcess,
  type ErlangNamedProcess,
  type VisibleTerm,
} from "./processes.js";

export {
  erlangActor,
  makeErlangConnect,
  makeErlangFactory,
  makeErlangRef,
  type ErlangAddress,
  type ErlangFactory,
  type ErlangFound,
  type ErlangPublic,
  type ErlangSpec,
} from "./actor.js";

export {
  startNode,
  type ErlangNode,
  type EtfTerm,
  type NodeOptions,
} from "./node.js";

export { withTimeout } from "./timeout.js";
