// ── A process on the far side, as this side can use it ─────────────────────
//
// A handle.  It knows the name the far side calls the process and the id this
// connection knows it by, and one thing more than a bare reference has: a way to
// put a frame on the wire with that id.  Everything else it offers is what comes
// back because of it — the state that streams for it, the messages it emits, the
// methods it announced.
//
// A handle is not a process of this side's tree.  Nothing has to make it one:
// the far side's tree is already reachable through reflection, so asking the
// proxy for it walks that side and gives that tree.  A handle is how something
// on the far side is talked to, not where it sits here.

import type { Message } from "../types.js";
import { makeWaiter, type Waiter } from "../util.js";
import type { ProcessRef } from "./process-ref.js";

/** What a process left behind when it ended. */
export interface RemoteExit {
  code: number;
  state: unknown;
}

/** How a handle gets a frame onto the connection it belongs to, addressed to a
 *  process the far side holds. */
export type FrameSink = (frame: Record<string, unknown>, to: number) => void;

/** An out-message of the far process, and the name it came with. */
export type RemoteMessage<OutMsg extends Message = Message> = (msg: OutMsg, fromName: string) => void;

export class RemoteProcess<InMsg extends Message = Message, OutMsg extends Message = Message> {
  /** The name the far side knows it by. */
  readonly pname: string;
  /** The id this connection knows it by — the far side's own, since it is the
   *  side that holds the process. */
  readonly ref: ProcessRef;
  /** A symbol of this side's own, so a handle can be told apart from any other
   *  the way a process is: by holding one. */
  readonly id: symbol;
  /** What the far side has said about its state so far. */
  state: Record<string, unknown> | null = null;
  /** The methods the far side announced it can answer. */
  readonly $reflection: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

  private pvtSend: FrameSink;
  private pvtFromName: string;
  private pvtConnected = true;
  /** What the far side said when it ended, or null while it is running. */
  private pvtExit: RemoteExit | null = null;
  private pvtExitWaiter: Waiter<RemoteExit> | null = null;
  private pvtMessageSubs: Array<RemoteMessage<OutMsg>> = [];
  private pvtStateSubs: Array<() => void> = [];

  constructor(ref: ProcessRef, send: FrameSink, fromName: string) {
    this.ref = ref;
    this.pname = ref.pname;
    this.id = Symbol(ref.pname);
    this.pvtSend = send;
    this.pvtFromName = fromName;
  }

  /** Whether the connection this handle lives on is still there.  It is the only
   *  thing "alive" can mean for a process on the other end. */
  isConnected(): boolean {
    return this.pvtConnected;
  }

  /**
   * The connection is gone, or the far side said the process is.  A handle that
   * cannot reach anything says so: there is no reconnect to wait for, so a send
   * fails here and now rather than disappearing into nothing.
   */
  disconnect(): void {
    if (!this.pvtConnected) return;
    this.pvtConnected = false;
    this.pvtStateSubs.forEach((fn) => fn());
    // Whoever is waiting for it to end is waiting for news that can no longer come.
    this.pvtExitWaiter?.reject(new Error(`${this.pname} cannot be reached: the connection is closed`));
  }

  /** Whether the process it names has ended, as far as this side has been told. */
  hasEnded(): boolean {
    return this.pvtExit !== null;
  }

  /** Why nothing can be asked of it, or nothing when it can still be reached. */
  private pvtUnreachable(): string | null {
    if (this.pvtExit !== null) return `${this.pname} has ended`;
    if (!this.pvtConnected) return `${this.pname} cannot be reached: the connection is closed`;
    return null;
  }

  private pvtReachable(): void {
    const why = this.pvtUnreachable();
    if (why !== null) throw new Error(why);
  }

  /**
   * Wait for the process to end.  Its exit crosses back like everything else it
   * does, and what it left behind is the answer.
   *
   * A handle whose connection is gone rejects instead: what is left to wait for
   * after that is nothing, and a process that keeps running is not something this
   * side can tell from one that died with the wire.
   */
  wait(): Promise<RemoteExit> {
    if (this.pvtExit !== null) return Promise.resolve(this.pvtExit);
    const why = this.pvtUnreachable();
    if (why !== null) return Promise.reject(new Error(why));
    this.pvtExitWaiter ??= makeWaiter<RemoteExit>();
    return this.pvtExitWaiter.promise;
  }

  /**
   * Ask the far side to stop it.  Stops the way it always does there, and this
   * resolves when its exit has crossed back — which is all this side can know.
   * There is no deadline, so a process that refuses to stop leaves this pending.
   */
  stop(): Promise<void> {
    this.pvtReachable();
    this.pvtSend({ $stop: {} }, this.ref.id);
    return this.wait().then(() => undefined);
  }

  /** Stop feeding it messages.  It is still there: `send` still reaches it. */
  pause(): void {
    this.pvtReachable();
    this.pvtSend({ $pause: {} }, this.ref.id);
  }

  /** Feed it messages again. */
  resume(): void {
    this.pvtReachable();
    this.pvtSend({ $resume: {} }, this.ref.id);
  }

  /** Hand the far process a message. */
  send(msg: InMsg): void {
    this.pvtReachable();
    this.pvtSend({ $msg: { fromName: this.pvtFromName, body: msg } }, this.ref.id);
  }

  subscribe(channel: "message", cb: RemoteMessage<OutMsg>): () => void;
  subscribe(channel: "state", cb: () => void): () => void;
  subscribe(channel: "message" | "state", cb: RemoteMessage<OutMsg> | (() => void)): () => void {
    if (channel === "message") {
      const fn = cb as RemoteMessage<OutMsg>;
      this.pvtMessageSubs.push(fn);
      return () => this.pvtUnsubscribe(this.pvtMessageSubs, fn);
    }
    const fn = cb as () => void;
    this.pvtStateSubs.push(fn);
    return () => this.pvtUnsubscribe(this.pvtStateSubs, fn);
  }

  private pvtUnsubscribe<T>(list: Array<T>, fn: T): void {
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  // ── what the connection delivers ─────────────────────────────────────────
  // The handle does not read frames; the side that owns the connection hands it
  // what a frame about this process said.

  /** Its state, as the far side just published it. */
  receiveState(state: Record<string, unknown>): void {
    this.state = Object.assign(this.state ?? {}, state);
    this.pvtStateSubs.forEach((fn) => fn());
  }

  /** A message it emitted. */
  receiveMessage(msg: OutMsg, fromName: string): void {
    this.pvtMessageSubs.forEach((fn) => fn(msg, fromName));
  }

  /** It has ended, and this is what it left behind.  The last thing said about a
   *  process: nothing more about it crosses after its exit. */
  receiveExit(exit: RemoteExit): void {
    if (this.pvtExit !== null) return;
    this.pvtExit = exit;
    this.pvtExitWaiter?.resolve(exit);
  }

  /** The methods it can answer, as functions that ask it for an answer.  `call`
   *  is the connection's own: a handle knows what to ask for, not how a call is
   *  made or paired with its answer. */
  receiveMethods(names: string[], call: (name: string, args: unknown[]) => Promise<unknown>): void {
    for (const name of names) {
      this.$reflection[name] = (...args: unknown[]) => call(name, args);
    }
  }
}
