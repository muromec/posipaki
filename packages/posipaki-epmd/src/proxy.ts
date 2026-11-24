// ── a registered process on a node, as an actor here ────────────────────────
//
// The proxy holds nothing: it carries. What arrives as ETF_RAW goes to the name it was forked with, as a
// DOP_REG_SEND whose payload is that term; what the node sends to this proxy's pid comes back out as ETF_RAW, with
// the term the node wrote.
//
// Its argument is a *name* — a `NodeRef`, which is a cluster and a node in it — so the connection is looked up and
// opened in `setup`, through the cluster that owns such things, and the actor itself knows nothing about hosts,
// mappers or handshakes.
//
// The body is a term and not a run of octets: a caller composes it with the writers in `terms.ts`, and a term this
// side can read but cannot write — a reference, a fun, a port — is complained about where it is sent, loudly, and
// dropped rather than taking the process down.
//
// Two facts the contract has no room for, and so they are here instead: a node can answer but never confirm, because
// erts drops a send to a name nobody answers in silence; and one proxy is one pid, which is what makes a reply
// routable at all when one connection carries several proxies.

import { defineActor, defineMessages } from "posipaki";
import type { Channel } from "posipaki/port";

import { clusterNamed, type Cluster, type NodeRef, type PidTerm } from "./cluster.js";
import type { WireMessage } from "./messages.js";
import { unwritable, type Term } from "./terms.js";

/** The one message shape a proxy has: the BEAM term itself, in and out. */
export interface EtfRaw {
  type: "ETF_RAW";
  body: Term;
}

export interface ProxyArgs {
  /** The node, by name: which cluster to look it up in, and what it is called there. */
  readonly node: NodeRef;
  /** The name registered on that node which this proxy stands for. */
  readonly processName: string;
}

/** What a proxy publishes: the pid this side answers at on that node, which is what a peer addresses. */
export interface EtfPublic {
  readonly erlangPid: PidTerm;
}

interface Private {
  readonly node: NodeRef;
  readonly processName: string;
  readonly cluster: Cluster;
  readonly pid: PidTerm;
  readonly messages: Channel<WireMessage>;
  /** The pid of the process this proxy speaks for: the one the caller put in its term, and the one an answer names. */
  readonly caller: PidTerm | null;
  stopReading: () => void;
}

/** Whether two pids name the same process: the node, the id, the serial and the incarnation all have to agree. */
export function samePid(one: Term, other: PidTerm): boolean {
  return (
    one.kind === "pid" &&
    one.node === other.node &&
    one.id === other.id &&
    one.serial === other.serial &&
    one.creation === other.creation
  );
}

/** A process on an Erlang node, as an actor of this side. */
export const ErlangProxy = defineActor({
  name: "erlang-proxy",
  inMessages: defineMessages<EtfRaw>(),
  outMessages: defineMessages<EtfRaw>(),

  async setup(args: ProxyArgs): Promise<{ public: EtfPublic; private: Private }> {
    const cluster = clusterNamed(args.node.cluster);
    const messages = await cluster.channel(args.node);
    const held: Private = {
      node: args.node,
      processName: args.processName,
      cluster,
      // This proxy's own pid, from its own identity: the address a node answers when it is this process it was told
      // about.
      pid: cluster.pidOf(this.self),
      // And the caller's, because the caller is the one that wants the answer: it puts its own pid in the term it
      // sends, so a reply comes back addressed to a process this connection does not belong to.
      caller:
        this.ctx.parentName === null || this.ctx.parentId === null
          ? null
          : cluster.pidOf({ pname: this.ctx.parentName, id: this.ctx.parentId }),
      messages,
      stopReading: () => undefined,
    };

    // Subscribed before the actor is up, so a reply that follows the first send cannot arrive before a reader exists.
    held.stopReading = messages.onFrame((said: WireMessage) => {
      if (said.kind !== "message" || said.payload === null) return;
      if (said.control.kind !== "send") return;
      if (named(said.control.to, held)) this.emit({ type: "ETF_RAW", body: said.payload });
    });
    messages.onClose((reason) => this.exit(`the connection to ${args.node.node} ended: ${reason}`));

    return { public: { erlangPid: held.pid }, private: held };
  },

  beforeEnd() {
    this.state.private.stopReading();
  },

  handlers: {
    async ETF_RAW(message: EtfRaw) {
      await this.send(message.body);
    },
  },

  methods: {
    /** One term to the name this proxy stands for. A node with nobody registered under it says nothing back. */
    async send(body: Term): Promise<void> {
      const held = this.state.private;
      const why = unwritable(body);
      if (why !== null) {
        // Loud, and not fatal: the caller asked for a term this side cannot put on the wire, and the connection and
        // every other proxy on it have nothing to do with that.
        console.error(`erlang-proxy: ${held.processName} on ${held.node.node}: ${why}`);
        return;
      }
      await held.messages.send({
        kind: "message",
        control: { kind: "regSend", from: held.pid, to: held.processName },
        payload: body,
      });
    },
  },
});

/** Whether an address is one this proxy speaks for: its own, or the caller's. */
function named(to: Term, held: Private): boolean {
  return samePid(to, held.pid) || (held.caller !== null && samePid(to, held.caller));
}
