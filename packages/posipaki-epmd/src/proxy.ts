// ── a process on another node, as an actor here ─────────────────────────────
//
// The proxy holds nothing: it carries. A `SEND` from its parent goes to the address it was built with; what the node
// delivers to the proxy's own pid comes back out as the term it was, with who asked.
//
// The node does the routing: the proxy is held by it, so a send addressed to its pid is handed to it as an in-message,
// and the actor itself knows nothing about hosts, mappers, handshakes or connections.
//
// The body is a term and not a run of octets: a caller composes it with the writers in `terms.ts`, and a term this side
// can read but cannot write — a reference, a fun, a port — is complained about where it is sent, loudly, and dropped
// rather than taking the process down.
//
// One fact the contract has no room for: a node can answer but never confirm, because erts drops a send to a name nobody
// answers in silence.

import { defineActor, defineMessages } from "posipaki";

import type { EtfAsked } from "./node.js";
import type { ErlangProcess, Reach, VisibleTerm } from "./processes.js";

/** A proxy is given the node it lives on by the caller: the one verb it needs is the one that gives it an address. */
export type ProxyNode = Pick<Reach, "pidOf">;

/** A caller's word to a proxy: one term to the process it stands for. The other in-message is what a node delivers. */
export interface EtfSend {
  type: "SEND";
  body: VisibleTerm;
}

/** A proxy of one process on another node: a term sent in goes to its address, and what the node delivers comes out. */
export function proxyOf(node: ProxyNode, ref: ErlangProcess) {
  return defineActor({
    name: "erlang-proxy",
    inMessages: defineMessages<EtfSend | EtfAsked>(),
    outMessages: defineMessages<EtfAsked>(),

    setup() {
      // An address of this side, minted by the node: what the far side answers to, and what routes the answer here.
      node.pidOf(this.self);
      // A proxy stands for a process: when that process ends, so does this one, with the same reason.
      void ref.wait().then((reason) => this.exit(reason));
      return undefined;
    },

    handlers: {
      async SEND(said: EtfSend) {
        await ref.send(said.body, this.self);
      },
      // A term the node routed here: it came from the far side, so it goes up as it arrived, with who asked.
      ETF_RAW(asked: EtfAsked) {
        this.emit(asked);
      },
    },
  });
}
