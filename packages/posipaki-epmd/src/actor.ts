// ── a process on another node, as an actor ─────────────────────────────────
//
// An actor of this module stands for one process on another node, and does one thing: a term it is given goes to that
// process. The three makers differ only in where the address comes from.
//
//   makeErlangRef({node, process})             the address is in the definition
//   makeErlangConnect()                        the address is in the fork's args
//   makeErlangFactory({node, module, fname})   the fork's args are the remote function's parameters
//
// An answer does not come back here. A term says where its answer goes, and the layer composing it puts a process of
// this side inside — `processTerm(this.self)` — which crosses as the pid the answer is routed to.

import { defineActor, defineMessages, type ActorDefinition } from "posipaki";

import type { NodeRef, Watch } from "./cluster.js";
import { nodeNamed, type EtfAsked } from "./node.js";
import {
  processNamed,
  type ErlangNamedProcess,
  type ErlangProcess,
  type Reach,
  type Start,
  type VisibleTerm,
} from "./processes.js";

/** Where a process on another node is: the node, and the name that node registered it under. */
export interface ErlangAddress {
  readonly node: NodeRef;
  readonly process: string;
}

/** What a factory starts: the node, the module, and the function with its arity as Erlang writes it, `there-spawner/1`. */
export interface ErlangFactory {
  readonly node: NodeRef;
  readonly module: string;
  readonly fname: string;
}

/** A process on another node, and the node that reaches it. */
export interface ErlangFound {
  readonly reach: Reach;
  readonly far: ErlangProcess | ErlangNamedProcess;
}

/** What one of these actors is built from: a name for the tree, and how to find the process it stands for. */
export interface ErlangSpec<Args> {
  readonly name: string;
  /** Called once, when the actor starts. A throw fails the start with its sentence. */
  find(args: Args): ErlangFound | Promise<ErlangFound>;
}

/** What a parent reads of one: the process or the name it stands for. */
export interface ErlangPublic {
  readonly far: ErlangProcess | ErlangNamedProcess;
}

type ErlangState = { public: ErlangPublic; private: { far: ErlangProcess | ErlangNamedProcess } };

/**
 * An actor over one process on another node.
 *
 * In `ETF_RAW {body}` writes the body to it. posipaki's `STOP` ends the actor, and the process over there is not told.
 * When the process over there ends, this actor ends with the same reason.
 */
export function erlangActor<Args>(
  spec: ErlangSpec<Args>,
): ActorDefinition<Args, ErlangState, EtfAsked, never, {}> {
  return defineActor({
    name: spec.name,
    inMessages: defineMessages<EtfAsked>(),
    outMessages: defineMessages<never>(),

    async setup(args: Args): Promise<ErlangState> {
      const { reach, far } = await spec.find(args);
      // An address of this side: a send to a registered name says who sent it, and this is the pid that says it.
      reach.pidOf(this.self);
      // It stands for a process: when that process ends, so does this one, with the same reason. A name ends with the
      // process holding it, and the watch on a name answers the same way.
      void far
        .monitor()
        .then((watch: Watch) => watch.ended)
        .then((reason: VisibleTerm) => this.exit(reason));
      return { public: { far }, private: { far } };
    },

    handlers: {
      async ETF_RAW(asked: EtfAsked) {
        const far = this.state.private.far;
        // `{6}` names its sender and `{2}` has no slot for one: which verb goes out depends on what this stands for.
        if ("pid" in far) await far.send(asked.body);
        else await far.send(asked.body, this.self);
      },
    },
  });
}

/** A process another node knows by name, with the address written where the definition is. */
export function makeErlangRef(address: ErlangAddress): ActorDefinition<undefined, ErlangState, EtfAsked, never, {}> {
  return erlangActor({ name: address.process, find: () => named(address) });
}

/** The same actor, with the address in the args it is forked with. */
export function makeErlangConnect(): ActorDefinition<ErlangAddress, ErlangState, EtfAsked, never, {}> {
  return erlangActor<ErlangAddress>({ name: "erlang", find: named });
}

/** A function started on another node, with the args it is forked with as that function's parameters. */
export function makeErlangFactory(
  facts: ErlangFactory,
): ActorDefinition<readonly VisibleTerm[], ErlangState, EtfAsked, never, {}> {
  return erlangActor({
    name: facts.fname,
    find: async (params: readonly VisibleTerm[]) => {
      const reach = nodeNamed(facts.node.cluster);
      return { reach, far: await reach.spawn(facts.node, callOf(facts.module, facts.fname, params)) };
    },
  });
}

/** A process another node knows by name: the address a ref and a connect actor are both built for. */
function named(address: ErlangAddress): ErlangFound {
  const reach = nodeNamed(address.node.cluster);
  return { reach, far: processNamed(address.node, address.process, reach) };
}

/** `there-spawner/1` as the call it names, refused when the parameters given are not the arity it states. */
function callOf(module: string, fname: string, args: readonly VisibleTerm[]): Start {
  const slash = fname.lastIndexOf("/");
  const arity = Number(fname.slice(slash + 1));
  if (slash <= 0 || !Number.isInteger(arity)) {
    throw new Error(`${fname} is not a function and its arity: \`there-spawner/1\` names one, \`there-spawner\` does not`);
  }
  if (arity !== args.length) {
    throw new Error(`${module}:${fname} takes ${arity} parameters, and ${args.length} were given`);
  }
  return { module, function: fname.slice(0, slash), args };
}
