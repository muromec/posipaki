// ── Process references on the wire ─────────────────────────────────────────
//
// A process is not JSON: it holds state, children and methods.  So a reflection
// method that returns one cannot answer with the process itself — it answers
// with a reference, and the caller is handed what it can read: a name, and an id
// this connection uses for that process.
//
// The id belongs to the connection and to the side that holds the process: that
// side allocates it, and both sides then know the process by it.  Allocated once
// per process — handed over twice, it is the same reference both times — and
// never reused, so an id whose process is gone resolves to nothing rather than to
// whatever came after it.
//
// The two sides allocate from one space, split by parity: the client takes the
// odd ids, the server the even ones, and the root is 0 on both.  So an id says
// on its own which side holds the process it names, and a frame's address means
// the same thing whoever reads it.
//
// Every connection has a root: id 0, held on both sides — the far actor on one,
// the proxy that asked for it on the other.  A frame that names no process
// addresses it, which is what every frame has always meant, so traffic for the
// root reads exactly as it did before there were ids at all.

import { isProcess } from "../process.async.js";
import type { RemoteProcess } from "./remote-process.js";

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

/** The little a table needs of what it holds to name it: what it is called, and
 *  the symbol that identifies it in this build. */
export interface ProcessHandle {
  readonly pname: string;
  readonly id: symbol;
}

/** Which ids a side hands out: the client takes the odd ones, the server the
 *  even ones, so one number can never name a process on both sides at once. */
export type IdParity = "odd" | "even";

/**
 * The processes one connection knows, by the ids that name them.  One table per
 * connection, because an id means nothing on any other one, and it lives exactly
 * as long as the connection that owns it.
 *
 * It holds two sets, told apart by parity rather than kept apart by a rule: the
 * processes this side holds — the root, and anything it hands over — and the ones
 * the far side holds, which this side knows as handles.  A frame's address is
 * looked up in both, and exactly one can answer.
 */
export class ProcessTable<P extends ProcessHandle = ProcessHandle> {
  /** This side's own processes, by the ids it gave them. */
  private pvtMine = new Map<number, P>();
  private pvtMineIds = new Map<P, number>();
  /** The far side's processes, by the ids they came with. */
  private pvtTheirs = new Map<number, P>();
  /** The next id this side may hand out: its own parity, 0 being the root's. */
  private pvtNext: number;
  /** Told the first time a process is numbered — the moment it is about to
   *  cross the connection. */
  private pvtOnCrossed: ((proc: P, id: number) => void) | undefined;

  constructor(parity: IdParity, onCrossed?: (proc: P, id: number) => void) {
    this.pvtNext = parity === "odd" ? 1 : 2;
    this.pvtOnCrossed = onCrossed;
  }

  /** Bind this side's own end of the connection — the root — to id 0. */
  bindRoot(proc: P): void {
    const bound = this.pvtMine.get(ROOT_ID);
    if (bound !== undefined && bound !== proc) {
      throw new Error("ProcessTable: the root is already bound");
    }
    this.pvtMine.set(ROOT_ID, proc);
    this.pvtMineIds.set(proc, ROOT_ID);
  }

  /** The id this side gives a process it holds, allocating one the first time. */
  handleFor(proc: P): number {
    const known = this.pvtMineIds.get(proc);
    if (known !== undefined) return known;
    const id = this.pvtNext;
    this.pvtNext += 2;
    this.pvtMine.set(id, proc);
    this.pvtMineIds.set(proc, id);
    this.pvtOnCrossed?.(proc, id);
    return id;
  }

  /** A process this side holds, by the id it gave it. */
  processFor(id: number): P | undefined {
    return this.pvtMine.get(id);
  }

  /**
   * Register a process the far side holds — a handle — under the id it arrived
   * with.  The root is not one of these: the far side's root is the process this
   * side already holds under id 0, the proxy on one end of the connection and
   * the actor on the other.
   */
  bindFar(id: number, proc: P): void {
    if (id === ROOT_ID) {
      throw new Error("ProcessTable: the root is this side's own, not something to bind");
    }
    this.pvtTheirs.set(id, proc);
  }

  /** A process the far side holds, by the id it gave it. */
  farHandleFor(id: number): P | undefined {
    return this.pvtTheirs.get(id);
  }

  /**
   * Whatever this connection knows `id` to mean: a process this side holds, or a
   * handle on one the far side holds.  Only one of the two can answer, because
   * the two sides take their ids from different halves of the space — so what
   * comes back does not depend on which way the frame was going.
   */
  resolve(id: number): P | undefined {
    return this.pvtMine.get(id) ?? this.pvtTheirs.get(id);
  }

  /**
   * Let go of an id: the process behind it is not this connection's business any
   * more, so it is no longer known by it.  Both sides' ids go the same way — the
   * side that lets a handle go names the far side's id, the side that is asked to
   * forget names its own — and an id let go is never handed out again, so nothing
   * that still names it can come to mean another process.
   *
   * The root is not something a connection lets go of: it is this side's own end,
   * so releasing it would leave the connection without a name for itself.
   */
  release(id: number): P | undefined {
    if (id === ROOT_ID) return undefined;
    const mine = this.pvtMine.get(id);
    if (mine !== undefined) {
      this.pvtMine.delete(id);
      this.pvtMineIds.delete(mine);
      return mine;
    }
    const theirs = this.pvtTheirs.get(id);
    if (theirs !== undefined) this.pvtTheirs.delete(id);
    return theirs;
  }

  /** Every handle this side holds on a process of the far side. */
  handles(): P[] {
    return [...this.pvtTheirs.values()];
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

/** Whether `value` has the shape of a handle on a far-side process.  Judged by
 *  what it holds rather than by `instanceof`, for the reason a process is: one
 *  build can hold two copies of the class. */
export function isRemoteProcess(value: unknown): value is RemoteProcess {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { pname?: unknown; id?: unknown; ref?: unknown; send?: unknown };
  return (
    typeof candidate.pname === "string" &&
    typeof candidate.id === "symbol" &&
    typeof candidate.send === "function" &&
    asProcessRef({ [PROCESS_REF]: candidate.ref }) !== null
  );
}

/**
 * Replace every process in `value` with the reference this connection uses for
 * it, so what is left is JSON that says which processes the answer is about.
 *
 * A handle goes back as the reference it came with, id and all: that id is the
 * far side's own, the one it will be read by.
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
  if (isRemoteProcess(value)) {
    return { [PROCESS_REF]: { id: value.ref.id, pname: value.ref.pname } };
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

/** How a side turns a reference into something it can hold: a handle. */
export type RefResolver = (ref: ProcessRef) => unknown;

/** Replace every reference in `value` with what `resolve` makes of it. */
export function decodeProcessRefs(
  value: unknown,
  resolve: RefResolver,
  seen: Set<unknown> = new Set(),
): unknown {
  const ref = asProcessRef(value);
  if (ref) return resolve(ref);
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((item) => decodeProcessRefs(item, resolve, seen));
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = decodeProcessRefs(item, resolve, seen);
    }
    return copy;
  }
  return value;
}
