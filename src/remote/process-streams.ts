// ── What a process says once it has crossed ─────────────────────────────────
//
// A process that crosses the connection is numbered, and from that moment the
// other side can be told about it: what it can answer, what it holds, and what it
// emits.  Both ends say exactly this about the processes they hold — the side that
// hands one over, and the side that serves one — so it is written once here
// rather than once per side.

import { isProcess, type AnyProcess } from "../process.async.js";
import { REFLECT_METHODS, STREAM_KINDS, type StreamKind } from "./channel.js";

import type { FrameSink } from "./remote-process.js";

/** What a process can be asked over the wire: the functions on its reflection
 *  surface, read once.  On the side that serves it the list *is* the dispatch
 *  table, so a name that was never on it can never be reached. */
const pvtReflectionNames = new WeakMap<object, string[]>();

export function reflectionNames(target: { $reflection?: unknown }): string[] {
  const known = pvtReflectionNames.get(target);
  if (known) return known;
  const surface = (target.$reflection ?? {}) as Record<string, unknown>;
  const names = Object.keys(surface).filter((name) => typeof surface[name] === "function");
  pvtReflectionNames.set(target, names);
  return names;
}

/**
 * The processes of one side that have crossed, and what the far side is told
 * about them.
 *
 * A stream starts once the frame that carried the reference is out: frames about
 * a process the reader cannot name yet have nowhere to land.  The table numbers a
 * process while that frame is being written, so the numbering is queued here and
 * let out by `flush` right after the frame goes — which is the only thing a
 * caller has to remember.
 *
 * What a stream says is what the far side asked for.  A process that crosses is silent
 * until something over there asks to hear it, and `tune` is that asking: only the
 * categories it names cross.  The root of the connection is no exception.  It is
 * registered here the moment the connection opens, and a side that wants to hear it
 * asks, which is what a visitor's proxy does for the state and messages it stands in
 * for.
 */

/** One process that crossed, and what is said about it now. */
interface StreamRecord {
  target: AnyProcess;
  /** The categories that cross, out of the three. */
  kinds: Set<StreamKind>;
  /** How to stop hearing one that is armed.  `exit` is not among them: a stream
   *  has to hear the end to know it is over, and what it does with the news is
   *  the question `kinds` answers. */
  stops: Map<StreamKind, () => void>;
}

export class ProcessStreams {
  private pvtSink: FrameSink;
  /** The id of the connection's own end.  Its end is the connection's end, so the side
   *  that owns the wire says it, awaited there, instead of this watching for it as it
   *  watches any other process's. */
  private pvtRootId: number;
  private pvtPending: Array<[AnyProcess, number]> = [];
  private pvtRecords = new Map<number, StreamRecord>();
  private pvtFlushing = false;

  constructor(sink: FrameSink, rootId: number) {
    this.pvtSink = sink;
    this.pvtRootId = rootId;
  }

  /** A process was numbered: it is about to cross.  Anything that is not a
   *  process — a handle travelling back to the side that holds it — crosses as
   *  the reference it came with and is nobody's to stream. */
  crossed(proc: unknown, id: number): void {
    if (!isProcess(proc)) return;
    this.pvtPending.push([proc, id]);
  }

  /** Say what there is to say about whatever crossed while a frame was written. */
  flush(): void {
    if (this.pvtFlushing) return;
    this.pvtFlushing = true;
    try {
      while (this.pvtPending.length > 0) {
        const next = this.pvtPending.shift();
        if (next) this.pvtStream(next[0], next[1]);
      }
    } finally {
      this.pvtFlushing = false;
    }
  }

  /**
   * What to say about it from now on: the categories named, and none of the
   * others.  Asking for its state says it there and then — a handle that has just
   * asked what it holds should not have to wait for it to change.
   *
   * An id with no stream here is not this side's to tune, and the frame is
   * dropped: both sides tune only what they hold, so an id names a stream on the
   * side that numbered it.
   */
  tune(id: number, kinds: StreamKind[]): void {
    const record = this.pvtRecords.get(id);
    if (!record) return;
    const wanted = new Set(kinds);
    for (const kind of STREAM_KINDS) {
      const isOn = record.kinds.has(kind);
      const want = wanted.has(kind);
      if (want === isOn) continue;
      if (want) {
        record.kinds.add(kind);
        this.pvtArm(record, id, kind);
      } else {
        record.kinds.delete(kind);
        this.pvtDisarm(record, kind);
      }
    }
  }

  /**
   * Say nothing more about this one.  It is not that the process ended — the far
   * side asked to be left out of it, so its exit is nobody's news over here, and
   * dropping the subscription is what keeps it from being sent.
   */
  stop(id: number): void {
    const record = this.pvtRecords.get(id);
    if (!record) return;
    for (const stop of record.stops.values()) stop();
    this.pvtRecords.delete(id);
  }

  /** Nothing more is said about any of them: the connection is done. */
  stopAll(): void {
    for (const id of [...this.pvtRecords.keys()]) this.stop(id);
    this.pvtPending.length = 0;
  }

  private pvtStream(target: AnyProcess, id: number): void {
    // Nothing to begin with: what is said about a process is what the far side asks
    // for, and the root is asked for like anything else.
    const record: StreamRecord = {
      target,
      kinds: new Set(),
      stops: new Map(),
    };
    this.pvtRecords.set(id, record);
    // What it can answer comes first: a handle that hears from a process it cannot
    // name yet has nowhere to put the news.  It is not one of the three categories
    // — a handle with no methods can do nothing with the process however much it
    // is told about it — so it crosses even in silence.
    this.pvtSink({ [REFLECT_METHODS]: reflectionNames(target) }, id);
    for (const kind of record.kinds) this.pvtArm(record, id, kind);
    // Its end is the last thing ever said about it, and the one thing a stream has
    // to hear to know it is over, whether or not the far side is told.  A process
    // that fails to run takes the same road as one that finishes.
    //
    // Not for the root.  Its end is the connection's end, and the side that owns the
    // wire says it while taking the wire down, awaiting it there because that frame has
    // to be out before the close.  Both of them end up in `sayEnded`.
    if (id !== this.pvtRootId) {
      void target.wait().then(
        () => void this.sayEnded(id, 0),
        () => void this.sayEnded(id, 1),
      );
    }
  }

  /** Start saying this much about it, and say what there is to say now. */
  private pvtArm(record: StreamRecord, id: number, kind: StreamKind): void {
    if (kind === "message") {
      record.stops.set(
        "message",
        record.target.subscribe("message", (msg, sender) => {
          this.pvtSink({ $msg: { fromName: sender.fromName, body: msg } }, id);
        }),
      );
      return;
    }
    if (kind === "state") {
      record.stops.set(
        "state",
        record.target.subscribe("state", () => {
          this.pvtSink({ $state: record.target.state as Record<string, unknown> }, id);
        }),
      );
      // Asked for, so said now: in silence the far side has heard nothing about
      // its state, and this is the first word rather than a repeat.
      this.pvtSink({ $state: record.target.state as Record<string, unknown> }, id);
    }
    // `exit` needs no subscription: the end is watched from the moment the process
    // crosses, since a stream has to know when it is over.  Whether it is sent is
    // read from `kinds` when it comes.
  }

  private pvtDisarm(record: StreamRecord, kind: StreamKind): void {
    const stop = record.stops.get(kind);
    if (!stop) return;
    stop();
    record.stops.delete(kind);
  }

  /**
   * It has ended: say so once, if that is among the categories asked for, and say
   * nothing more about it either way.  Awaited by whoever has to have the frame out
   * before the wire closes, which is the root's end and nobody else's — no other
   * process can end after this side has stopped saying anything about it.
   */
  async sayEnded(id: number, code: number): Promise<void> {
    const record = this.pvtRecords.get(id);
    if (!record) return;
    const told = record.kinds.has("exit");
    const state = record.target.state;
    this.stop(id);
    if (told) await this.pvtSink({ $exit: { code, state } }, id);
  }
}
