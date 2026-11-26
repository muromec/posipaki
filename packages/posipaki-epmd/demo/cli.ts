// ── the command line, as an actor ───────────────────────────────────────────
//
// It forks the proxy for the name it was given, sends it one term, prints what comes back and exits. Nothing here
// waits on a wire: the child's answer is this actor's own in-message, which is what an actor is for.
//
// The node is asked for by the cluster name the reference carries, and this actor is held by it: the term carries this
// process's own address, so the answer is routed back here.

import { defineActor, defineMessages } from "posipaki";

import type { NodeRef } from "../src/cluster.js";
import { nodeNamed, type EtfAsked } from "../src/node.js";
import { processNamed, processTerm, show } from "../src/processes.js";
import { proxyOf } from "../src/proxy.js";
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
  inMessages: defineMessages<EtfAsked>(),
  outMessages: defineMessages<never>(),

  async setup(args: CliArgs) {
    const node = nodeNamed(args.node.cluster);
    // An address for this actor: the answer is addressed to the pid the term carries, and the node routes it here.
    node.serve(null, this.self);
    const proxy = await this.fork(proxyOf(node, processNamed(args.node, args.processName, node)), undefined, {
      name: args.processName,
    });
    // The actor names a process and nothing else: the term carries `this.self`, and the layers turn it into an address
    // on the way out and back into a handle on the way in.
    await proxy.send({ type: "SEND", body: tuple(processTerm(this.self), binary(Buffer.from(args.message, "utf8"))) });
    return { public: null, private: { args } };
  },

  handlers: {
    ETF_RAW(asked: EtfAsked) {
      console.log(show(asked.body));
      this.exit("the answer is printed");
    },
  },
});
