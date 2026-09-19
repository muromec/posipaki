// ── The call side of a connection ───────────────────────────────────────────
//
// Both ends of a seam make calls and answer them, and the machinery is the same
// once the wire is: a `seq` the connection counts, the calls waiting under it, the
// surface a handle reads to make one, and the answer that names which call it
// settles.  Only where a frame leaves differs between the two ends, which is why
// that is the one thing handed in and the rest is written once.

import { isProcess } from "../process.async.js";
import {
  REFLECT_CALL,
  REFLECT_RESULT,
  asReflectionResult,
  encodeFrame,
  jsonProblem,
  type ReflectionCall,
} from "./channel.js";
import {
  encodeProcessRefs,
  isRemoteProcess,
  type ProcessHandle,
  type ProcessTable,
} from "./process-ref.js";
import { reflectionNames } from "./process-streams.js";

/** A frame on its way out: encoded, addressed, and written to this end's wire. */
export type WireSink = (frame: Record<string, unknown>) => Promise<void>;

export class CallSide {
  /**
   * `seq` belongs to this connection and is never reused, so two calls to the same
   * method in flight at once stay apart; the answer names the one it belongs to,
   * whichever process it was asked of.
   */
  private pvtCalls = 0;
  private pvtWaiting = new Map<
    number,
    { name: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private pvtWrite: WireSink;
  private pvtTable: ProcessTable<ProcessHandle>;

  constructor(write: WireSink, table: ProcessTable<ProcessHandle>) {
    this.pvtWrite = write;
    this.pvtTable = table;
  }

  /**
   * Ask a process on the far side for one of its methods.  Processes among the
   * arguments become references first — this side's own, with ids from its table, or
   * the far side's coming back — and what is left has to be JSON, or nothing is sent
   * at all.
   */
  call(method: string, callArgs: unknown[], to: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const seq = ++this.pvtCalls;
      const frame = encodeFrame(
        { [`${REFLECT_CALL}${method}`]: { seq, args: callArgs } },
        this.pvtTable,
        to,
      );
      const problem = jsonProblem(frame);
      if (problem !== null) {
        reject(new Error(`cannot send ${problem} to ${method}`));
        return;
      }
      this.pvtWaiting.set(seq, { name: method, resolve, reject });
      void this.pvtWrite(frame).catch((error: unknown) => {
        this.pvtWaiting.delete(seq);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /**
   * One function per announced name, on the surface whoever calls reads.
   *
   * An answer that carries a reference hands it to whoever asked, which makes it theirs to
   * deal with: the handle that was asked is told about it, so that one nobody keeps is let
   * go of with that handle rather than being nobody's for ever.
   */
  install(surface: Record<string, unknown>, methods: string[], to: number): void {
    for (const method of methods) {
      surface[method] = async (...callArgs: unknown[]) => {
        const value = await this.call(method, callArgs, to);
        const owner = this.pvtTable.farHandleFor(to);
        if (isRemoteProcess(owner)) owner.markTransient(value);
        return value;
      };
    }
  }

  /**
   * An answer to a call this side made: the call waiting under that `seq` is settled
   * by it, and the frame says whether it was one at all.  An answer is about the call
   * and not about a process, so a dispatcher reads it before it looks anything up.
   */
  settle(frame: Record<string, unknown>): boolean {
    const result = asReflectionResult(frame);
    if (!result) return false;
    const waiting = this.pvtWaiting.get(result.seq);
    if (waiting) {
      this.pvtWaiting.delete(result.seq);
      if (result.error === undefined) waiting.resolve(result.value);
      else waiting.reject(new Error(`${waiting.name}: ${result.error}`));
    }
    return true;
  }

  /** A call that was in flight when the wire went has no answer coming; it fails
   *  here rather than hanging for ever. */
  rejectAll(): void {
    for (const waiting of this.pvtWaiting.values()) {
      waiting.reject(new Error(`connection closed before ${waiting.name} answered`));
    }
    this.pvtWaiting.clear();
  }
}

/**
 * Answer one call with what the process said, or why it could not.  A method may be
 * written for a call that answers later; the wire has no opinion about that, it just
 * waits for the frame.
 */
export async function answerCall(
  call: ReflectionCall,
  target: ProcessHandle | undefined,
  write: WireSink,
  table: ProcessTable<ProcessHandle>,
): Promise<void> {
  // An answer goes back to the far side's own end of the connection: a result is about
  // the call and not about a process, and the one waiting for it is out there.
  const reply = (body: Record<string, unknown>) =>
    write(encodeFrame({ [`${REFLECT_RESULT}${call.name}`]: body }, table, table.farRootId()));
  // Only a process this side holds can be asked: the id a call names is the holder's
  // own, and this side is the holder of what it holds.
  if (!isProcess(target)) {
    await reply({ seq: call.seq, error: "no process with that id on this connection" });
    return;
  }
  const names = reflectionNames(target);
  const surface = target.$reflection as unknown as Record<string, Function>;
  const method = names.includes(call.name) ? surface[call.name] : undefined;
  if (typeof method !== "function") {
    await reply({ seq: call.seq, error: `no reflection method named ${call.name}` });
    return;
  }
  try {
    // References in the arguments arrived as handles on processes of this side's own,
    // and processes in the answer become references.  What is left has to be JSON, or
    // the call is refused rather than half-written.
    const value = encodeProcessRefs(await method(...call.args), table);
    const problem = jsonProblem(value);
    if (problem !== null) {
      await reply({
        seq: call.seq,
        error: `${call.name} returned ${problem}, which cannot cross a frame`,
      });
      return;
    }
    await reply({ seq: call.seq, value });
  } catch (err) {
    await reply({ seq: call.seq, error: err instanceof Error ? err.message : String(err) });
  }
}
