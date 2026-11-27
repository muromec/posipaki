// ── the command line, as an actor ───────────────────────────────────────────
//
// It forks an actor that stands for the name it was given, sends it one term, prints what comes back and exits. Nothing
// here waits on a wire: the answer is this actor's own in-message, because the term carries this actor's address.
//
// The node is asked for by the cluster name the reference carries, and this actor is served by it: the term carries this
// process's own address, which is what the answer is routed to.

import { defineActor, defineMessages } from "posipaki";

import { makeErlangRef } from "../src/actor.js";
import type { NodeRef } from "../src/cluster.js";
import { nodeNamed, type EtfTerm } from "../src/node.js";
import { processTerm, show } from "../src/processes.js";
import { binary, tuple } from "../src/terms.js";

export interface CliArgs {
  /** The node whose process is asked, by name. */
  readonly node: NodeRef;
  /** The name registered on that node. */
  readonly processName: string;
  /** The text the term will carry. */
  readonly message: string;
}

/** Asks one name on one node, and ends with the answer printed. */
export const Cli = defineActor({
  name: "cli",
  inMessages: defineMessages<EtfTerm>(),
  outMessages: defineMessages<never>(),

  async setup(args: CliArgs) {
    const node = nodeNamed(args.node.cluster);
    // An address for this actor: the answer is addressed to the pid the term carries, and the node routes it here.
    node.pidOf(this.self);
    const peer = await this.fork(makeErlangRef({ node: args.node, process: args.processName }), undefined, {
      name: args.processName,
    });
    // The term names this process, and the layers turn that into an address on the way out and a handle on the way in.
    await peer.send({ type: "ETF_RAW", body: tuple(processTerm(this.self), binary(Buffer.from(args.message, "utf8"))) });
    return { public: null, private: { args } };
  },

  handlers: {
    ETF_RAW(asked: EtfTerm) {
      console.log(show(asked.body));
      this.exit("the answer is printed");
    },
  },
});
