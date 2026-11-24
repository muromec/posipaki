// ── the command line, as an actor ───────────────────────────────────────────
//
// It forks the proxy for the name it was given, sends it one term, prints what comes back and exits. Nothing here
// waits on a wire: the child's answer is this actor's own in-message, which is what an actor is for.

import { defineActor, defineMessages } from "posipaki";

import { clusterNamed, type NodeRef } from "../src/cluster.js";
import { ErlangProxy, type EtfRaw } from "../src/proxy.js";
import { binary, render, tuple } from "../src/terms.js";

export interface CliArgs {
  /** The node whose process is asked, by name. */
  readonly node: NodeRef;
  /** The name registered on that node. */
  readonly processName: string;
  /** The text the term will carry. */
  readonly message: string;
}

interface Private {
  readonly args: CliArgs;

}

/** Asks one name on one node, and ends with the answer printed. */
export const Cli = defineActor({
  name: "cli",
  inMessages: defineMessages<EtfRaw>(),
  outMessages: defineMessages<never>(),

  async setup(args: CliArgs): Promise<{ public: null; private: Private }> {
    const cluster = clusterNamed(args.node.cluster);
    const proxy = await this.fork(ErlangProxy, { node: args.node, processName: args.processName }, {
      name: args.processName,
    });
    // The pid belongs to the child: it minted it from its own identity when it came up, and asking the cluster for
    // the pid of a process you hold answers the same one — no state read, and nothing to check for null.
    const ourPid = cluster.pidOf(proxy);

    console.log(`${args.node.node}@${args.node.host} as ${args.processName}, our pid ${ourPid.id}`);

    await proxy.send({ type: "ETF_RAW", body: tuple(ourPid, binary(Buffer.from(args.message, "utf8"))) });
    // Nothing else needs the handle: a child lives and ends with this actor.
    return { public: null, private: { args } };
  },
  handlers: {
    ETF_RAW(message: EtfRaw) {
      console.log(render(message.body));
      this.exit("the answer is printed");
    },
  },
});
