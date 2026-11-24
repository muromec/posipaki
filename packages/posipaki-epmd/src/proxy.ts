// ── a registered process on a node, as an actor here ────────────────────────
//
// The proxy holds nothing: it carries. What arrives as ETF_RAW goes to the name it was forked with, as a
// DOP_REG_SEND whose payload is that term; what the node sends to this proxy's pid comes back out as ETF_RAW, with
// the term the node wrote.
//
// The body is a term and not a run of octets: a caller composes it with the writers in `terms.ts`, and a term this
// side can read but cannot write — a reference, a fun, a port — is refused where it is sent, by name, rather than
// dropped on the floor.
//
// Two facts the contract has no room for, and so they are here instead: a node can answer but never confirm, because
// erts drops a send to a name nobody answers in silence; and one proxy is one pid, which is what makes a reply
// routable at all when one connection carries several proxies.

import { defineActor, defineMessages } from "posipaki";
import type { Channel } from "posipaki/port";

import type { WireMessage } from "./messages.js";
import type { PidTerm } from "./network.js";
import { write, type Term } from "./terms.js";

/** A node this side can reach: what it is called, the channel messages go over, and a pid to answer at. */
export interface NodeRef {
  readonly name: string;
  channel(): Promise<Channel<WireMessage>>;
  /** A pid on this side for one proxy, distinct from every other proxy's on the same node. */
  address(): PidTerm;
}

/** The one message shape a proxy has: the BEAM term itself, in and out. */
export interface EtfRaw {
  type: "ETF_RAW";
  body: Term;
}

export interface ProxyArgs {
  readonly node: NodeRef;
  /** The name registered on that node which this proxy stands for. */
  readonly processName: string;
}

interface Private {
  readonly node: NodeRef;
  readonly processName: string;
  readonly pid: PidTerm;
  readonly messages: Channel<WireMessage>;
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

  async setup(args: ProxyArgs): Promise<{ public: null; private: Private }> {
    const messages = await args.node.channel();
    return {
      public: null,
      private: {
        node: args.node,
        processName: args.processName,
        // One pid per proxy: a reply is addressed to it, and one connection carries every proxy of that node.
        pid: args.node.address(),
        messages,
        stopReading: () => undefined,
      },
    };
  },

  afterStart() {
    const held = this.state.private;
    held.stopReading = held.messages.onFrame((said: WireMessage) => this.received(said));
    held.messages.onClose((reason) => this.exit(`the connection to ${held.node.name} ended: ${reason}`));
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
        console.error(`erlang-proxy: ${held.processName} on ${held.node.name}: ${why}`);
        return;
      }
      await held.messages.send({
        kind: "message",
        control: { kind: "regSend", from: held.pid, to: held.processName },
        payload: body,
      });
    },

    /** One frame from the node: news if it is addressed to this proxy's pid, and nothing otherwise. */
    received(said: WireMessage): void {
      const held = this.state.private;
      if (said.kind !== "message" || said.payload === null) return;
      if (said.control.kind !== "send" || !samePid(said.control.to, held.pid)) return;
      this.emit({ type: "ETF_RAW", body: said.payload });
    },
  },
});

/**
 * Why a term cannot go on this wire, or null when it can.
 *
 * The writers in `terms.ts` refuse what they cannot compose — a reference, because an id it cannot mint would be a
 * lie about its node — and this asks them before anything is written, so the refusal is a complaint at the point of
 * the call rather than a throw out of the process's own loop.
 */
export function unwritable(body: Term): string | null {
  try {
    write(body);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
