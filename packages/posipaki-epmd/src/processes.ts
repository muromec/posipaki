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
  if (isRemote(term)) return wirePidOf(term.process.address);
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
  if (term.kind === "remote") return `#remote<${describe(term.process.address)}>`;
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
}

/**
 * A process on another node: an address and the verbs the wire has for it.
 *
 * A pid is what a term carries and what an exit names. A registered name is how a node is asked for a process nobody
 * handed out an address for, and it carries no sender — a message to one says who sent it, so `send` takes the process.
 */
export interface ErlangProcess {
  readonly address: Address;
  /**
   * Who a term says sent it: a process of this side, or one over there whose pid this side writes as the sender.
   *
   * A name is not a sender — the `{6}` control carries a pid — so an address without one is refused where it is written.
   */
  send(body: VisibleTerm, from?: TermSender): Promise<void>;
  /** A watch on it: settles with the reason it ended and never rejects. Nothing is owed the other way. */
  monitor(): Promise<Watch>;
  /** Ends it with `kill`. The wire wants a sender, and this side mints one. */
  kill(): Promise<void>;
  /** Links a process of this side to this one: whichever ends first takes the other with it. */
  link(process: AnyProcess): Promise<void>;
  /** The reason it ended: `monitor().ended`. */
  wait(): Promise<VisibleTerm>;
}

/** Where a process over there is: the pid a term carries, or the name a node registered it under. */
export type Address =
  | { readonly kind: "pid"; readonly pid: PidTerm }
  | { readonly kind: "name"; readonly ref: NodeRef; readonly name: string };

/** A sender a term may name: a process of this side, or one over there. */
export type TermSender = AnyProcess | ErlangProcess;

/** The pid an address names, or null for a name: only a pid fits in a term, and only a pid is exited or linked. */
function pidOfAddress(address: Address): PidTerm | null {
  return address.kind === "pid" ? address.pid : null;
}

/**
 * The pid a `{6}` writes as its sender.
 *
 * An address over there supplies its own pid, which is how a node relays a term on another node's behalf. A name has no
 * pid to write, and a process of this side is minted and served by `pidOf`.
 */
export function senderPidOf(from: TermSender, pidOf: (process: AnyProcess) => PidTerm): PidTerm {
  if (!("address" in from)) return pidOf(from);
  if (from.address.kind === "pid") return from.address.pid;
  throw new Error(`${from.address.name} is a registered name, and a sender is a pid: \`{6, From, '', Name}\` carries one`);
}

/** The pid a walk writes, or a refusal: a name has no place in a term. */
function wirePidOf(address: Address): PidTerm {
  if (address.kind === "pid") return address.pid;
  throw new Error(`${address.name} is a registered name, and a term carries addresses: a pid has one`);
}

/** A process on another node, by the address it was found at. */
export function erlangProcess(address: Address, reach: Reach): ErlangProcess {
  const watch = (): Promise<Watch> =>
    address.kind === "pid" ? reach.watch(address.pid) : reach.watchName(address.ref, address.name);
  return {
    address,
    async send(body, from) {
      if (address.kind === "pid") {
        await reach.send(address.pid, forWire(body, (handle) => reach.pidOf(handle)));
        return;
      }
      // `{6, From, '', Name}` names its sender, unlike `{2, '', To}`: a name-addressed send is one a process makes.
      if (from === undefined) {
        throw new Error(`a message to ${address.name} must say who sent it: \`{6, From, '', Name}\` carries a sender`);
      }
      await reach.sendReg(address.name, address.ref, forWire(body, (handle) => reach.pidOf(handle)), from);
    },
    monitor: watch,
    async kill() {
      const pid = pidOfAddress(address);
      if (pid === null) throw new Error(`a name cannot be exited: \`{3, From, To, Reason}\` carries a pid`);
      await reach.kill(pid);
    },
    async link(process) {
      const pid = pidOfAddress(address);
      if (pid === null) throw new Error(`a name cannot be linked: \`{1, From, To}\` carries a pid`);
      await reach.link(reach.pidOf(process), pid);
    },
    async wait() {
      return forHere(await (await watch()).ended, {
        here: (found) => reach.processOf(found),
        there: (found) => erlangProcess({ kind: "pid", pid: found }, reach),
      });
    },
  };
}

/** A process of another node named by its pid. */
export function processAt(pid: PidTerm, reach: Reach): ErlangProcess {
  return erlangProcess({ kind: "pid", pid }, reach);
}

/** A process of another node named by the name its node registered. */
export function processNamed(ref: NodeRef, name: string, reach: Reach): ErlangProcess {
  return erlangProcess({ kind: "name", ref, name }, reach);
}

/** An address as one line, for a message that names one. */
function describe(address: Address): string {
  return address.kind === "pid" ? `${address.pid.node}.${address.pid.id}` : `${address.name}@${address.ref.host}`;
}
