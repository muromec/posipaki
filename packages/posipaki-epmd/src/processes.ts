// ── processes in a term ─────────────────────────────────────────────────────
//
// An actor says *which process*; the layers say *which address*. A term on its way out may carry a process of this
// side — `{kind: "process", handle}` — and the walk replaces it with the pid this node minted for it. A term on its way
// in carries pids, and the walk replaces each with the process it names: one of ours becomes a local handle, one of the
// node's becomes an `ErlangProcess`, which sends and watches through the node the term arrived on.
// Both replacements are structural: a process can sit at any depth of a tuple, a list or a map, and the walk goes
// everywhere a term goes. `write` refuses both kinds, so a term that has not been through here cannot be put on the
// wire by accident.

import type { AnyProcess } from "posipaki";

import type { NodeRef, ProcessHandle, Watch } from "./cluster.js";
import { render, type Term } from "./terms.js";

/** A pid, as the wire writes it. */
export type PidTerm = Extract<Term, { kind: "pid" }>;

/** A process of this side in a term that has not crossed: the layers below swap it for its pid. */
export interface LocalProcess {
  readonly kind: "process";
  readonly handle: AnyProcess;
}

/** The leaf that stands for a process of the other node. */
export interface RemoteInTerm {
  readonly kind: "remote";
  readonly process: ErlangProcess;
}

/** A term a caller may build: the wire's own leaves, and a process of either side. */
export type VisibleTerm = Term<LocalProcess | RemoteInTerm>;

/** The value a local process is written as, before it crosses. */
export function processTerm(handle: AnyProcess): Term<LocalProcess> {
  return { kind: "process", handle };
}

/** The value a process on the other node is read as. */
export function remoteTerm(process: ErlangProcess): Term<RemoteInTerm> {
  return { kind: "remote", process };
}

function isProcess(term: VisibleTerm): term is LocalProcess {
  return term.kind === "process";
}

function isRemote(term: VisibleTerm): term is RemoteInTerm {
  return term.kind === "remote";
}

/** The same term with every process replaced by the address `pidOf` gives it. */
export function forWire(term: VisibleTerm, pidOf: (process: AnyProcess) => PidTerm): Term {
  if (isProcess(term)) return pidOf(term.handle);
  if (isRemote(term)) return term.process.pid;
  switch (term.kind) {
    case "tuple":
      return { kind: "tuple", items: term.items.map((item) => forWire(item, pidOf)) };
    case "list":
      return { kind: "list", items: term.items.map((item) => forWire(item, pidOf)) };
    case "map":
      return { kind: "map", pairs: term.pairs.map(([key, value]) => [forWire(key, pidOf), forWire(value, pidOf)]) };
    case "atom":
    case "int":
    case "float":
    case "binary":
    case "string":
    case "pid":
    case "ref":
      return term;
  }
}

/** What a pid means to the caller of a proxy. */
export interface Readers {
  /** A pid of this runtime's own node: the process it names, or null when nobody holds that id. */
  here(pid: PidTerm): AnyProcess | null;
  /** A pid of the node the term came from: how to send back to it. */
  there(pid: PidTerm): ErlangProcess;
}

/** The same term with every pid replaced by the process it names, whichever side of the wire that is. */
export function forHere(term: Term, readers: Readers): VisibleTerm {
  switch (term.kind) {
    case "pid": {
      const mine = readers.here(term);
      return mine === null ? remoteTerm(readers.there(term)) : processTerm(mine);
    }
    case "tuple":
      return { kind: "tuple", items: term.items.map((item) => forHere(item, readers)) };
    case "list":
      return { kind: "list", items: term.items.map((item) => forHere(item, readers)) };
    case "map":
      return {
        kind: "map",
        pairs: term.pairs.map(([key, value]) => [forHere(key, readers), forHere(value, readers)]),
      };
    case "atom":
    case "int":
    case "float":
    case "binary":
    case "string":
    case "ref":
      return term;
  }
}

/** A term as one line, with a process named as what it is rather than as an address. */
export function show(term: VisibleTerm): string {
  if (term.kind === "process") return `#process<${term.handle.pname}>`;
  if (term.kind === "remote") return `#remote<${describe(term.process)}>`;
  switch (term.kind) {
    case "tuple":
      return `{${term.items.map(show).join(", ")}}`;
    case "list":
      return `[${term.items.map(show).join(", ")}]`;
    case "map":
      return `#{${term.pairs.map(([key, value]) => `${show(key)} => ${show(value)}`).join(", ")}}`;
    default:
      return render(term);
  }
}

/** What a node is asked to start: one module and function, and the arguments it is called with. */
export interface Start {
  readonly module: string;
  readonly function: string;
  /** The function's parameters. A process of this side may be one: it crosses as its pid. */
  readonly args: readonly VisibleTerm[];
}

/**
 * What an actor beside a node uses of it: the verbs for a process over there, and the one that gives it an address here.
 * Written out rather than as the node's type, so a handle carries no process and a double answers nine methods.
 */
export interface Reach {
  /** The pid this side answers at for a process, and what serves it at that address. */
  pidOf(process: AnyProcess): PidTerm;
  processOf(pid: PidTerm): AnyProcess | null;
  send(pid: PidTerm, body: Term): Promise<void>;
  /**
   * One term to a registered name, with the sender the `{6}` control carries.
   *
   * The sender is a process of this side, which is minted and served, or a pid this side relays for — a node answering on
   * another node's behalf. An address with no pid has nothing to write there.
   */
  sendReg(name: string, ref: NodeRef, body: Term, from: TermSender): Promise<void>;
  watch(pid: PidTerm): Promise<Watch>;
  watchName(ref: NodeRef, name: string): Promise<Watch>;
  kill(pid: PidTerm): Promise<void>;
  link(from: PidTerm, to: PidTerm): Promise<void>;
  /** Asks the node to start `module:function(args)` and answers a handle to the process it started. */
  spawn(ref: NodeRef, call: Start): Promise<ErlangProcess>;
  /** What a node's registered name leads to now, or null when nobody holds it. */
  resolveName(name: string, ref: NodeRef): Promise<ErlangProcess | null>;
}

/**
 * A process on another node, by the pid it has.
 *
 * A pid is what a term carries and what an exit or a link names, so every verb here writes one.
 */
export interface ErlangProcess {
  readonly pid: PidTerm;
  /** One term to it: `{2, '', To}` carries no sender. */
  send(body: VisibleTerm): Promise<void>;
  /** A watch on it: settles with the reason it ended and never rejects. Nothing is owed the other way. */
  monitor(): Promise<Watch>;
  /** Ends it with `kill`. The wire wants a sender, and this side mints one. */
  kill(): Promise<void>;
  /** Links a process of this side to this one: whichever ends first takes the other with it. */
  link(process: AnyProcess): Promise<void>;
  /** The reason it ended: `monitor().ended`. */
  wait(): Promise<VisibleTerm>;
}

/**
 * A process on another node, by the name its node registered.
 *
 * A name is written into `{6}` and `{19}` as it stands, and the node holding it resolves it when the message lands. It has
 * no pid, so nothing here exits it, links it, or writes it as a sender.
 */
export interface ErlangNamedProcess {
  /** The node that holds the name. */
  readonly ref: NodeRef;
  readonly name: string;
  /** One term to the name: `{6, From, '', Name}` carries the process sending it. */
  send(body: VisibleTerm, from: TermSender): Promise<void>;
  /** A watch on the name. `{19}` may carry a name, and the answer names the pid it resolved to. */
  monitor(): Promise<Watch>;
  /**
   * The process holding the name now.
   *
   * The node is asked (`erlang:whereis` over its RPC server), so this costs a round trip and answers the pid-bearing
   * handle. Refused with a sentence when nobody holds the name.
   */
  resolve(): Promise<ErlangProcess>;
}

/** A sender a term may name: a process of this side, or one over there. */
export type TermSender = AnyProcess | ErlangProcess;

/** The pid a `{6}` writes as its sender: one over there is relayed as it stands, a process of this side is minted. */
export function senderPidOf(from: TermSender, pidOf: (process: AnyProcess) => PidTerm): PidTerm {
  return "pname" in from ? pidOf(from) : from.pid;
}

/** A process of another node, by the pid it has. */
export function processAt(pid: PidTerm, reach: Reach): ErlangProcess {
  const watch = (): Promise<Watch> => reach.watch(pid);
  return {
    pid,
    async send(body) {
      await reach.send(pid, forWire(body, (handle) => reach.pidOf(handle)));
    },
    monitor: watch,
    async kill() {
      await reach.kill(pid);
    },
    async link(process) {
      await reach.link(reach.pidOf(process), pid);
    },
    async wait() {
      return forHere(await (await watch()).ended, {
        here: (found) => reach.processOf(found),
        there: (found) => processAt(found, reach),
      });
    },
  };
}

/** A process of another node, by the name its node registered. */
export function processNamed(ref: NodeRef, name: string, reach: Reach): ErlangNamedProcess {
  return {
    ref,
    name,
    async send(body, from) {
      await reach.sendReg(name, ref, forWire(body, (handle) => reach.pidOf(handle)), from);
    },
    monitor: () => reach.watchName(ref, name),
    async resolve() {
      const found = await reach.resolveName(name, ref);
      if (found === null) throw new Error(`nothing on ${ref.node}@${ref.host} holds ${name}`);
      return found;
    },
  };
}

/** An address as one line, for a message that names one. */
function describe(where: ErlangProcess | ErlangNamedProcess): string {
  return "pid" in where ? `${where.pid.node}.${where.pid.id}` : `${where.name}@${where.ref.host}`;
}
