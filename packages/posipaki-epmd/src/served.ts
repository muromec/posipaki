// ── a node, from this side: the processes we serve to it ────────────────────
//
// The mirror of the proxy. A proxy is one process of the node seen from here; this is one connection from the node,
// serving the processes here — the ones it can address by name, and the ones whose pid it addresses.
//
// A message arrives addressed to a name or to a pid of this side, and both are looked up in the same table: the name
// it carries, or the process the pid was minted for. The process behind the address is handed the term with `forHere`
// applied, together with the way to answer — a remote reference on the process that asked — so an actor never sees an
// address it has to spell out, and never mints one.

import { defineActor, defineMessages, type Message } from "posipaki";
import type { Channel } from "posipaki/port";

import { clusterNamed, type Cluster, type NodeRef, type PidTerm } from "./cluster.js";
import type { Peer } from "./handshake.js";
import type { WireMessage } from "./messages.js";
import { forHere, forWire, type RemoteProcess, type Readers, type VisibleTerm } from "./processes.js";
import type { Term } from "./terms.js";

/** A process this side serves to the node: what it is called there, and where its messages go. */
/** A process this side serves: what it answers to, where its messages go, and the identity the cluster knows it by. */
export interface ServedProcess {
  readonly pname: string;
  readonly id: symbol;
  send(message: Message): unknown;
}

export interface Served {
  /** The name the node addresses it by. */
  readonly name: string;
  /** The process: anything whose in-message union takes `ETF_RAW`. */
  readonly process: ServedProcess;
}

/** What a served process is handed: the term, and who asked. */
export interface Asked {
  type: "ETF_RAW";
  /** The process on the node that asked, as a remote reference: answering is `from.send(term)`. */
  from: RemoteProcess;
  body: VisibleTerm;
}

export interface ServedArgs {
  /** The node this connection is to, by name. */
  readonly node: NodeRef;
  /** What the node calls itself, from the handshake. Absent for a connection this side opened, whose peer is the ref. */
  readonly peer?: Peer;
  /** The connection a `listen` accepted. */
  readonly messages: Channel<WireMessage>;
  /** The processes this connection serves. */
  readonly serves: readonly Served[];
}

interface Private {
  readonly args: ServedArgs;
  readonly byName: Map<string, ServedProcess>;
  stopReading: () => void;
}

/** One connection, serving the processes its arguments name. */
export const ErlangNode = defineActor({
  name: "erlang-node",
  inMessages: defineMessages<never>(),
  handlers: {},
  outMessages: defineMessages<never>(),

  setup(args: ServedArgs): { public: null; private: Private } {
    const byName = new Map<string, ServedProcess>();
    for (const served of args.serves) byName.set(served.name, served.process);
    return { public: null, private: { args, byName, stopReading: () => undefined } };
  },

  afterStart() {
    const held = this.state.private;
    const cluster = clusterNamed(held.args.node.cluster);
    held.stopReading = held.args.messages.onFrame((said: WireMessage) => this.delivered(said, cluster));
    held.args.messages.onClose((reason) => this.exit(`the connection to ${namedOf(held.args)} ended: ${reason}`));
  },

  beforeEnd() {
    this.state.private.stopReading();
  },

  methods: {
    /** One frame from the node, delivered to whichever process its address names. */
    delivered(said: WireMessage, cluster: Cluster): void {
      if (said.kind !== "message") return;
      const control = said.control;
      if (control.kind !== "send" && control.kind !== "regSend") return;

      const process = this.target(control, cluster);
      if (process === null) {
        // A name or a pid nobody here answers. erts drops such a message on its own side without a word; this side
        // says it once, and does not fail a connection over it.
        console.error(
          `erlang-node: ${namedOf(this.state.private.args)} addressed ${described(control)}, which serves nobody here`,
        );
        return;
      }

      const from = pidIn(control.kind === "send" ? control.to : control.from);
      if (from === null) return;
      const asked: Asked = {
        type: "ETF_RAW",
        from: remoteAt(from, cluster),
        body: forHere(said.payload ?? { kind: "atom", name: "" }, readers(cluster)),
      };
      void process.send(asked);
    },

    /** The process an address names: a name this connection serves, or a pid this cluster minted. */
    target(control: { kind: "send"; to: Term } | { kind: "regSend"; from: Term; to: string }, cluster: Cluster): ServedProcess | null {
      if (control.kind === "regSend") return this.state.private.byName.get(control.to) ?? null;
      const pid = pidIn(control.to);
      if (pid === null) return null;
      const owner = cluster.processOf(pid);
      if (owner === null) return null;
      for (const served of this.state.private.args.serves) {
        if (served.process.pname === owner.pname && served.process.id === owner.id) return served.process;
      }
      return null;
    },
  },
});

/** The pid in a control field, or null when it is not one. */
function pidIn(term: Term): PidTerm | null {
  return term.kind === "pid" ? term : null;
}

/** A process of the node, as a served process is handed it: its address, and the way back to it. */
function remoteAt(pid: PidTerm, cluster: Cluster): RemoteProcess {
  return { pid, send: (body) => cluster.send(pid, forWire(body, (handle) => cluster.pidOf(handle))) };
}

/** How a pid on the node is read inside a term, and how one of ours is. */
function readers(cluster: Cluster): Readers {
  return {
    here: (pid) => cluster.processOf(pid),
    there: (pid) => remoteAt(pid, cluster),
  };
}

/** How an address reads in a refusal. */
function described(control: { kind: "send"; to: Term } | { kind: "regSend"; from: Term; to: string }): string {
  if (control.kind === "regSend") return `the name ${control.to}`;
  const pid = pidIn(control.to);
  return pid === null ? "an address this side does not read" : `the pid ${pid.node}.${pid.id}`;
}

/** What a connection is to, in a sentence: the node's own word for itself, or the reference this side opened it with. */
function namedOf(args: ServedArgs): string {
  return args.peer?.name ?? `${args.node.node}@${args.node.host}`;
}
