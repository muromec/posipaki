// ── Process references on the wire ─────────────────────────────────────────
//
// A process is not JSON: it holds state, children and methods.  So a reflection
// method that returns one cannot answer with the process itself — it answers
// with a reference, and the caller is handed what it can read: a name, and an
// id this connection uses for that process.
//
// The id belongs to the connection and to the side that holds the process.
// Allocated once per process — handed over twice, it is the same reference both
// times — and never reused, so an id whose process is gone resolves to nothing
// rather than to whatever came after it.
//
// Every connection has a root: id 0, held on both sides — the far actor on one,
// the proxy that asked for it on the other.  A frame that names no process
// addresses it, which is what every frame has always meant, so traffic for the
// root reads exactly as it did before there were ids at all.
//
// A reference for a process this side does not hold is not yet a handle.
// Parsing one gives a process it cannot reach: it knows what the far side calls
// it, not how to talk to it.  That is what parsing is worth on its own — the id
// is there, and what will resolve it is not.

import { isProcess } from "../process.async.js";
import type { AnyProcess } from "../process.async.js";

/** The key that marks a process reference inside an otherwise JSON value. */
export const PROCESS_REF = "$p";

/** The id a connection gives its own end: the root, named by carrying no id at
 *  all as much as by naming this one. */
export const ROOT_ID = 0;

/** What crosses the wire in place of a process. */
export interface ProcessRef {
  id: number;
  pname: string;
}

/**
 * A process on the far side, as this side knows it: an id and a name, and no way
 * to reach it.  A handle is the same reference once something can resolve the id
 * — until then this is what a caller gets.
 */
export class UnreachableRemoteProcess {
  readonly id: number;
  readonly pname: string;

  constructor(ref: ProcessRef) {
    this.id = ref.id;
    this.pname = ref.pname;
  }
}

/** The little a table needs of a process to name it: what it is called, and the
 *  symbol that identifies it in this build. */
export interface ProcessHandle {
  readonly pname: string;
  readonly id: symbol;
}

/**
 * The processes one connection knows, by the ids it hands out.  One table per
 * connection, because an id means nothing on any other one, and it lives exactly
 * as long as the connection that owns it.
 *
 * A side fills it from two ends: it binds its own root at 0, and it numbers
 * every process it hands over.  So the table is both what an outgoing frame
 * looks a process up in, and what an incoming frame's address resolves against.
 * What goes in is whatever that side has: on the server the actor it spawned, on
 * the client its own end of the connection.
 */
export class ProcessTable<P extends ProcessHandle = ProcessHandle> {
  private pvtById = new Map<number, P>();
  private pvtIds = new Map<P, number>();
  /** Starts at 1: id 0 is the root's, and is never handed to anything else. */
  private pvtNext = 0;

  /** Bind this side's own end of the connection — the root — to id 0. */
  bindRoot(proc: P): void {
    if (this.pvtById.has(ROOT_ID)) {
      throw new Error("ProcessTable: the root is already bound");
    }
    this.pvtById.set(ROOT_ID, proc);
    this.pvtIds.set(proc, ROOT_ID);
  }

  /** The id this connection uses for `proc`, allocating one the first time. */
  handleFor(proc: P): number {
    const known = this.pvtIds.get(proc);
    if (known !== undefined) return known;
    const id = ++this.pvtNext;
    this.pvtIds.set(proc, id);
    this.pvtById.set(id, proc);
    return id;
  }

  /** The process this connection knows by `id`, or undefined when it holds none. */
  processFor(id: number): P | undefined {
    return this.pvtById.get(id);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** Whether `value` is the wire form of a reference. */
export function asProcessRef(value: unknown): ProcessRef | null {
  if (typeof value !== "object" || value === null) return null;
  const ref = (value as Record<string, unknown>)[PROCESS_REF];
  if (typeof ref !== "object" || ref === null) return null;
  const { id, pname } = ref as Record<string, unknown>;
  if (typeof id !== "number" || typeof pname !== "string") return null;
  return { id, pname };
}

/**
 * Replace every process in `value` with the reference this connection uses for
 * it, so what is left is JSON that says which processes the answer is about.
 *
 * Containers are copied rather than rewritten: the objects belong to the actor
 * that returned them, and a state it is still running on is not ours to edit.  A
 * node already seen is left where it is — a cycle is the encoder's to report, not
 * something to walk forever.
 */
export function encodeProcessRefs(
  value: unknown,
  table: ProcessTable,
  seen: Set<unknown> = new Set(),
): unknown {
  if (value instanceof UnreachableRemoteProcess) {
    // A reference that is going back: the id it carries is the far side's own,
    // and that is the one it will be read by.
    return { [PROCESS_REF]: { id: value.id, pname: value.pname } };
  }
  if (isProcess(value)) {
    return { [PROCESS_REF]: { id: table.handleFor(value), pname: value.pname } };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((item) => encodeProcessRefs(item, table, seen));
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = encodeProcessRefs(item, table, seen);
    }
    return copy;
  }
  return value;
}

/** Replace every reference in `value` with the process this side knows of it. */
export function decodeProcessRefs(value: unknown, seen: Set<unknown> = new Set()): unknown {
  const ref = asProcessRef(value);
  if (ref) return new UnreachableRemoteProcess(ref);
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((item) => decodeProcessRefs(item, seen));
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = decodeProcessRefs(item, seen);
    }
    return copy;
  }
  return value;
}
