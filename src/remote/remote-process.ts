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
import type { ProcessRef } from "./process-ref.js";

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
  }

  /** Hand the far process a message. */
  send(msg: InMsg): void {
    if (!this.pvtConnected) {
      throw new Error(`${this.pname} cannot be reached: the connection is closed`);
    }
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

  /** The methods it can answer, as functions that ask it for an answer.  `call`
   *  is the connection's own: a handle knows what to ask for, not how a call is
   *  made or paired with its answer. */
  receiveMethods(names: string[], call: (name: string, args: unknown[]) => Promise<unknown>): void {
    for (const name of names) {
      this.$reflection[name] = (...args: unknown[]) => call(name, args);
    }
  }
}
