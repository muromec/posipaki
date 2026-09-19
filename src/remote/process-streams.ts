// ── What a process says once it has crossed ─────────────────────────────────
//
// A process that crosses the connection is numbered, and from that moment the
// other side can be told about it: what it can answer, what it holds, and what it
// emits.  Both ends say exactly this about the processes they hold — the side that
// hands one over, and the side that serves one — so it is written once here
// rather than once per side.

import { isProcess, type AnyProcess } from "../process.async.js";
import { REFLECT_METHODS } from "./channel.js";
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
 */
export class ProcessStreams {
  private pvtSink: FrameSink;
  private pvtPending: Array<[AnyProcess, number]> = [];
  private pvtStops = new Map<number, Array<() => void>>();
  private pvtFlushing = false;

  constructor(sink: FrameSink) {
    this.pvtSink = sink;
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
   * Say nothing more about this one.  It is not that the process ended — the far
   * side asked to be left out of it, so its exit is nobody's news over here, and
   * dropping the subscription is what keeps it from being sent.
   */
  stop(id: number): void {
    const stops = this.pvtStops.get(id);
    if (!stops) return;
    for (const stop of stops) stop();
    this.pvtStops.delete(id);
  }

  /** Nothing more is said about any of them: the connection is done. */
  stopAll(): void {
    for (const stops of this.pvtStops.values()) {
      for (const stop of stops) stop();
    }
    this.pvtStops.clear();
    this.pvtPending.length = 0;
  }

  private pvtStream(target: AnyProcess, id: number): void {
    const sink = this.pvtSink;
    this.pvtStops.set(id, [
      target.subscribe("message", (msg, sender) => {
        sink({ $msg: { fromName: sender.fromName, body: msg } }, id);
      }),
      target.subscribe("state", () => {
        sink({ $state: target.state as Record<string, unknown> }, id);
      }),
    ]);
    // What it can answer comes first: a handle that hears from a process it cannot
    // name yet has nowhere to put the news.
    sink({ [REFLECT_METHODS]: reflectionNames(target) }, id);
    sink({ $state: target.state as Record<string, unknown> }, id);
    // Its end is the last thing said about it.  A process that fails to run takes
    // the same road as one that finishes: the holder of the handle is told that it
    // is gone, and why, rather than left waiting for news that cannot come.
    void target.wait().then(
      () => this.pvtEnded(target, id, 0),
      () => this.pvtEnded(target, id, 1),
    );
  }

  /** It has ended: say so once, and say nothing more about it. */
  private pvtEnded(target: AnyProcess, id: number, code: number): void {
    const stops = this.pvtStops.get(id);
    if (!stops) return;
    for (const stop of stops) stop();
    this.pvtStops.delete(id);
    this.pvtSink({ $exit: { code, state: target.state } }, id);
  }
}
