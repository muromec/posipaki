// ── processes in a term ─────────────────────────────────────────────────────
//
// An actor says *which process*; the layers say *which address*. A term on its way out may carry a process of this
// side — `{kind: "process", handle}` — and the walk replaces it with the pid the cluster minted for it. A term on its
// way in carries pids, and the walk replaces each with the process it names: one of ours becomes the same kind of
// handle, one of the node's becomes a remote process, which knows how to send back through the proxy it arrived on.
//
// Both replacements are structural: a process can sit at any depth of a tuple, a list or a map, and the walk goes
// everywhere a term goes. `write` refuses both kinds, so a term that has not been through here cannot be put on the
// wire by accident.

import type { ProcessHandle } from "./cluster.js";
import { render, type Term } from "./terms.js";

/** A pid, as the wire writes it. */
export type PidTerm = Extract<Term, { kind: "pid" }>;

/** A process of this side in a term that has not crossed: the layers below swap it for its pid. */
export interface LocalProcess {
  readonly kind: "process";
  readonly handle: ProcessHandle;
}

/** A process of the node this side is talking to, as something that can be sent to. */
export interface RemoteProcess {
  /** Its address there. */
  readonly pid: PidTerm;
  /** One term to it, over the connection its pid arrived on. */
  send(body: VisibleTerm): Promise<void>;
}

/** The leaf that stands for a process of the other node. */
export interface RemoteInTerm {
  readonly kind: "remote";
  readonly process: RemoteProcess;
}

/** A term a caller may build: the wire's own leaves, and a process of either side. */
export type VisibleTerm = Term<LocalProcess | RemoteInTerm>;

/** The value a local process is written as, before it crosses. */
export function processTerm(handle: ProcessHandle): Term<LocalProcess> {
  return { kind: "process", handle };
}

/** The value a process on the other node is read as. */
export function remoteTerm(process: RemoteProcess): Term<RemoteInTerm> {
  return { kind: "remote", process };
}

function isProcess(term: VisibleTerm): term is LocalProcess {
  return term.kind === "process";
}

function isRemote(term: VisibleTerm): term is RemoteInTerm {
  return term.kind === "remote";
}

/** The same term with every process replaced by the address `pidOf` gives it. */
export function forWire(term: VisibleTerm, pidOf: (handle: ProcessHandle) => PidTerm): Term {
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
  here(pid: PidTerm): ProcessHandle | null;
  /** A pid of the node the term came from: how to send back to it. */
  there(pid: PidTerm): RemoteProcess;
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
  if (term.kind === "remote") return `#remote<${term.process.pid.node}.${term.process.pid.id}>`;
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
