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
import { PROCESS_REF, isRemoteProcess } from "./process-ref.js";
import { STREAM_KINDS, type StreamKind } from "./channel.js";
import type { ProcessRef } from "./process-ref.js";

/**
 * What a reference with nothing keeping it amounts to.  It names a process this side can
 * hear nothing from and ask nothing of, so it is not a process in any sense that matters
 * here, and it is written as what it is wherever it turns up: a state somebody is reading,
 * a log line, anything at all that stringifies.
 */
export const UNSTABLE_REFERENCE = "UnstableReference";

/** What a process left behind when it ended. */
/**
 * The references inside a value that crossed.  A handle is the one thing in a frame that is
 * not JSON, so wherever one sits, it came here on somebody else's frame and whoever is
 * holding that value is holding it.  Plain objects and arrays only: a value of another kind
 * is not a shape this walks, and its references are not found.
 */
function refsInside(value: unknown): RemoteProcess[] {
  const found: RemoteProcess[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (isRemoteProcess(node)) {
      found.push(node);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const proto = Object.getPrototypeOf(node) as object | null;
    if (proto !== Object.prototype && proto !== null) return;
    for (const item of Object.values(node as Record<string, unknown>)) walk(item);
  };
  walk(value);
  return found;
}

export interface RemoteExit {
  code: number;
  state: unknown;
}

/** How a handle gets a frame onto the connection it belongs to, addressed to a
 *  process the far side holds.  The answer is handed back when a caller has to know
 *  the frame is out — the root's end is said that way, just before the wire closes. */
export type FrameSink = (frame: Record<string, unknown>, to: number) => void | Promise<void>;

/** What a side does when it lets go of a handle: stop knowing the id, so nothing
 *  arriving for it can land here again. */
export type ReleaseHook = (id: number) => void;

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
  /** This side let it go: nothing more is asked of it, and nothing arriving for it
   *  is news any more.  Not the same as ending, and not the same as the connection
   *  going: in all three the handle is dead, and only the reason differs. */
  private pvtReleased = false;
  private pvtLetGo: ReleaseHook | undefined;
  /** What the far side said when it ended, or null while it is running. */
  private pvtExit: RemoteExit | null = null;
  private pvtExitWaiter: Waiter<RemoteExit> | null = null;
  private pvtMessageSubs: Array<RemoteMessage<OutMsg>> = [];
  private pvtStateSubs: Array<() => void> = [];
  /** Whoever is waiting to hear what it holds, settled by the first word of it. */
  private pvtReadyWaiters: Array<() => void> = [];
  /** How many times this reference has been kept.  Nothing is heard about a process
   *  nothing here keeps, so the count is what makes a handle usable rather than a name. */
  private pvtRefCount = 0;
  /** The handles this one keeps because they sit in what it holds.  Counted, and given
   *  back when this one is let go of: the thing holding them is here. */
  private pvtOwnedRefs: RemoteProcess[] = [];
  /** The handles that arrived here on their way somewhere else, in a message or an answer.
   *  Not counted — nobody here asked for them, and whoever receives them is the one to deal
   *  with them — but remembered, so that one nobody ever keeps is let go of after all. */
  private pvtTransientRefs: RemoteProcess[] = [];
  /** What this side has asked to be told about it.  A process that crosses is
   *  silent, so a handle starts out having asked for nothing and hears nothing
   *  until something here wants it — which is the same rule the far side holds,
   *  written from the other end. */
  private pvtWanted: Set<StreamKind> = new Set();

  constructor(ref: ProcessRef, send: FrameSink, fromName: string, letGo?: ReleaseHook) {
    this.ref = ref;
    this.pname = ref.pname;
    this.id = Symbol(ref.pname);
    this.pvtSend = send;
    this.pvtFromName = fromName;
    this.pvtLetGo = letGo;
  }

  /**
   * Whether the process this handle names can still be reached: the wire is there, and
   * this side has not let the handle go.
   *
   * Reaching it is not the same as it being alive.  A process that has ended is still
   * one this side has a handle on — it is what the handle points at, and what it left
   * behind is here — so an end does not put it out of reach; `hasEnded()` is that
   * answer, and the two are asked separately.  From the two ways out there is no coming
   * back: no reconnect, and no way to un-release.
   */
  isConnected(): boolean {
    return this.pvtConnected && !this.pvtReleased;
  }

  /**
   * The connection is gone.  Every handle this side holds goes out of reach with it,
   * and says so: there is no reconnect to wait for, so a send fails here and now
   * rather than disappearing into nothing.
   */
  disconnect(): void {
    if (!this.pvtConnected) return;
    this.pvtConnected = false;
    this.pvtStateSubs.forEach((fn) => fn());
    this.pvtSettleReady();
    // Whoever is waiting for it to end is waiting for news that can no longer come.
    this.pvtExitWaiter?.reject(new Error(`${this.pname} cannot be reached: the connection is closed`));
  }

  /** Whether the process it names has ended, as far as this side has been told. */
  hasEnded(): boolean {
    return this.pvtExit !== null;
  }

  /** Why nothing can be asked *of the process* — let go, ended, or out of reach — or
   *  nothing when something can.  Those are not one thing said three ways: an ended
   *  process is still reached, it simply has nothing left to receive. */
  private pvtWhyNotAskable(): string | null {
    if (this.pvtReleased) return `${this.pname} was released`;
    if (this.pvtExit !== null) return `${this.pname} has ended`;
    if (!this.pvtConnected) return `${this.pname} cannot be reached: the connection is closed`;
    return null;
  }

  private pvtRequireAskable(): void {
    const why = this.pvtWhyNotAskable();
    if (why !== null) throw new Error(why);
  }

  /**
   * Keep this reference: from here it is counted, which is what lets anything be asked of
   * it.  It returns the handle, so what is kept is written in one line —
   * `this.pvtRemoteRefsHeld.push(ref.holdRef())` — and a table of them reads as what it is.
   */
  holdRef(): this {
    this.pvtRefCount += 1;
    return this;
  }

  /**
   * Give the count back.  Whoever gives the last one back lets the reference go, which is
   * what tells the far side that nothing here wants to hear about the process again.  A
   * reference nobody ever kept is let go of by this too, which is how whoever receives one
   * they do not want is rid of it.
   */
  releaseRef(): void {
    if (this.pvtRefCount > 0) this.pvtRefCount -= 1;
    if (this.pvtRefCount === 0 && !this.pvtReleased) this.release();
  }

  /** How many times this reference has been kept. */
  refCount(): number {
    return this.pvtRefCount;
  }

  /**
   * What this is, as text: a handle nothing here keeps is an unstable reference and says
   * so, and one that is kept says which process it names and by which id.
   */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.pvtRefCount === 0 ? UNSTABLE_REFERENCE : `RemoteProcess(${this.ref.id}: ${this.pname})`;
  }

  /**
   * What this is, in JSON: the same reference the wire would carry, or the unstable thing
   * it is when nothing keeps it.  Written so that an unheld reference cannot be mistaken
   * for a process that merely looks odd in a state, and so that one that is kept reads as
   * the reference it is rather than as whatever fields it happens to have.
   */
  toJSON(): unknown {
    if (this.pvtRefCount === 0) return UNSTABLE_REFERENCE;
    return { [PROCESS_REF]: { id: this.ref.id, pname: this.pname } };
  }

  /**
   * Remember the references inside a value that arrived here to be passed on.  They are not
   * counted — the receiver is the one to deal with them — and this is what keeps one from
   * being nobody's for ever: when this handle is let go of, they are dropped with it.
   */
  markTransient(value: unknown): void {
    for (const ref of refsInside(value)) {
      if (ref.id === this.id || ref.pvtReleased) continue;
      this.pvtDropTransient(ref);
      if (this.pvtOwnedRefs.includes(ref) || this.pvtTransientRefs.includes(ref)) continue;
      this.pvtTransientRefs.push(ref);
    }
  }

  /** Stop treating a reference as one that was only passing through. */
  private pvtDropTransient(ref: RemoteProcess): void {
    const at = this.pvtTransientRefs.indexOf(ref);
    if (at >= 0) this.pvtTransientRefs.splice(at, 1);
  }

  /**
   * Keep the references sitting in what this process holds.  What it holds is here, so the
   * thing keeping those references alive is this handle, and it holds them until it is let
   * go of itself.
   */
  private pvtHoldOwned(value: unknown): void {
    for (const ref of refsInside(value)) {
      if (ref.id === this.id || ref.pvtReleased) continue;
      if (this.pvtOwnedRefs.includes(ref)) continue;
      this.pvtDropTransient(ref);
      this.pvtOwnedRefs.push(ref.holdRef());
    }
  }

  /** Nothing is heard about a process nothing here keeps.  A subscription, a tuning and a
   *  wait for the state are all ways of hearing, so they are where a reference has to have
   *  been kept first — and where the mistake says what to do about it. */
  private pvtRequireHeld(what: string): void {
    if (this.pvtRefCount > 0) return;
    throw new Error(
      `${this.pname} is not held by anyone here: call holdRef() to keep this reference, ` +
        `or releaseRef() to let it go, before ${what}`,
    );
  }

  /**
   * Wait until what it holds is here.
   *
   * A handle starts out knowing nothing about the process: the far side says what a
   * process holds when something over here asks to hear it, so the asking and the waiting
   * are one act, and this is both.  It settles with whatever has arrived when nothing more
   * can: a process that has ended has said its last, and a connection that has gone has
   * nothing left to say.  Asking twice is asking about what is already here.
   */
  ready(): Promise<void> {
    if (this.state !== null || this.pvtWhyNotAskable() !== null) return Promise.resolve();
    this.pvtRequireHeld("waiting for what it holds");
    this.pvtWant("state");
    return new Promise<void>((resolve) => this.pvtReadyWaiters.push(resolve));
  }

  /** Everyone waiting for what it holds has heard it, or never will. */
  private pvtSettleReady(): void {
    const waiting = this.pvtReadyWaiters;
    this.pvtReadyWaiters = [];
    for (const resolve of waiting) resolve();
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
    const why = this.pvtWhyNotAskable();
    if (why !== null) return Promise.reject(new Error(why));
    // Waiting for it to end is a subscription to its end: nothing here hears an
    // exit that was never asked for, so asking to wait asks for it.
    this.pvtWant("exit");
    this.pvtExitWaiter ??= makeWaiter<RemoteExit>();
    return this.pvtExitWaiter.promise;
  }

  /**
   * Ask the far side to stop it.  Stops the way it always does there, and this
   * resolves when its exit has crossed back — which is all this side can know.
   * There is no deadline, so a process that refuses to stop leaves this pending.
   */
  stop(): Promise<void> {
    this.pvtRequireAskable();
    // Ask for the end before asking it to stop: whether an exit is sent is decided
    // by what the far side has been asked for when it comes, so a stop ordered ahead
    // of the asking could leave nothing to wait for.
    this.pvtWant("exit");
    this.pvtSend({ $stop: {} }, this.ref.id);
    return this.wait().then(() => undefined);
  }

  /**
   * Let it go: the far side forgets this id and stops telling this side anything
   * about the process behind it.  The process itself is untouched — it runs on, it
   * is simply nobody's here any more — and this handle is done: nothing reaches it,
   * nothing is waited for, and what arrives for it later is not news.
   */
  release(): void {
    this.pvtRequireAskable();
    this.pvtReleased = true;
    const owned = this.pvtOwnedRefs;
    this.pvtOwnedRefs = [];
    for (const ref of owned) {
      if (!ref.pvtReleased) ref.releaseRef();
    }
    const transient = this.pvtTransientRefs;
    this.pvtTransientRefs = [];
    for (const ref of transient) {
      // One that was kept by whoever received it is theirs, and one that was never kept is
      // nobody's: there is nothing else that would ever let go of it.
      if (!ref.pvtReleased && ref.pvtRefCount === 0) ref.release();
    }
    this.pvtLetGo?.(this.ref.id);
    this.pvtSend({ $release: {} }, this.ref.id);
    this.pvtSettleReady();
  }

  /** Stop feeding it messages.  It is still there: `send` still reaches it. */
  pause(): void {
    this.pvtRequireAskable();
    this.pvtSend({ $pause: {} }, this.ref.id);
  }

  /** Feed it messages again. */
  resume(): void {
    this.pvtRequireAskable();
    this.pvtSend({ $resume: {} }, this.ref.id);
  }

  /**
   * What to be told about it from now on: any of `message`, `state` and `exit`,
   * or `"silent"` for none of it.
   *
   * A process that crossed is silent to begin with, so this is how a handle asks
   * to hear anything at all — and what is heard is only ever what was asked for.
   * An exit nobody asked for is not sent: silence is silence, which makes this the
   * one way to leave a handle that will not answer a `wait()`, and the far side's
   * books the one place an end can go unrecorded.
   */
  tune(kinds: StreamKind[] | "silent"): void {
    this.pvtRequireAskable();
    this.pvtRequireHeld("tuning what is heard about it");
    this.pvtTune(kinds === "silent" ? [] : kinds);
  }

  /** Ask the far side to say exactly this much, and nothing when it is already
   *  saying it.  The list goes in the order the three are named in, so asking for
   *  the same thing twice sends the same frame twice. */
  private pvtTune(wanted: StreamKind[]): void {
    const kinds = STREAM_KINDS.filter((kind) => wanted.includes(kind));
    if (kinds.length === this.pvtWanted.size && kinds.every((kind) => this.pvtWanted.has(kind))) {
      return;
    }
    this.pvtWanted = new Set(kinds);
    this.pvtSend({ $tune: { streams: kinds } }, this.ref.id);
  }

  /** Ask for one more category, because something here now wants it.  A handle
   *  that is gone asks nothing: there is no far side left to hear it, and nothing
   *  was asked for, so what was wanted stays what it was. */
  private pvtWant(kind: StreamKind): void {
    if (this.pvtWanted.has(kind)) return;
    if (!this.pvtConnected || this.pvtReleased) return;
    this.pvtTune([...this.pvtWanted, kind]);
  }

  /** Hand the far process a message. */
  send(msg: InMsg): void {
    this.pvtRequireAskable();
    this.pvtSend({ $msg: { fromName: this.pvtFromName, body: msg } }, this.ref.id);
  }

  /** Subscribe to what it says, or to what it holds.  Asking here is asking the far
   *  side: a subscription is the first thing that wants the category, so it is what
   *  turns it on, and unsubscribing leaves it on — the far side is not told to stop
   *  saying something that another subscriber may still want. */
  subscribe(channel: "message", cb: RemoteMessage<OutMsg>): () => void;
  subscribe(channel: "state", cb: () => void): () => void;
  subscribe(channel: "message" | "state", cb: RemoteMessage<OutMsg> | (() => void)): () => void {
    this.pvtRequireHeld(`subscribing to what it ${channel === "message" ? "says" : "holds"}`);
    if (channel === "message") {
      const fn = cb as RemoteMessage<OutMsg>;
      this.pvtMessageSubs.push(fn);
      this.pvtWant("message");
      return () => this.pvtUnsubscribe(this.pvtMessageSubs, fn);
    }
    const fn = cb as () => void;
    this.pvtStateSubs.push(fn);
    this.pvtWant("state");
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
    if (this.pvtReleased) return;
    this.state = Object.assign(this.state ?? {}, state);
    this.pvtHoldOwned(state);
    this.pvtStateSubs.forEach((fn) => fn());
    this.pvtSettleReady();
  }

  /** A message it emitted. */
  receiveMessage(msg: OutMsg, fromName: string): void {
    if (this.pvtReleased) return;
    // Anything that came along in the message came here on its way somewhere else.
    this.markTransient(msg);
    this.pvtMessageSubs.forEach((fn) => fn(msg, fromName));
  }

  /** It has ended, and this is what it left behind.  The last thing said about a
   *  process: nothing crosses about it after its exit, though the handle still
   *  reaches it for what it left. */
  receiveExit(exit: RemoteExit): void {
    if (this.pvtExit !== null || this.pvtReleased) return;
    this.pvtExit = exit;
    this.pvtExitWaiter?.resolve(exit);
    // Nobody is waiting for state from a process that has ended: what it left is all
    // there is, and nothing more is coming.
    this.pvtSettleReady();
  }

  /** The methods it can answer, as functions that ask it for an answer.  `call`
   *  is the connection's own: a handle knows what to ask for, not how a call is
   *  made or paired with its answer. */
  receiveMethods(names: string[], call: (name: string, args: unknown[]) => Promise<unknown>): void {
    for (const name of names) {
      this.$reflection[name] = async (...args: unknown[]) => {
        const value = await call(name, args);
        // A reference in an answer was handed to whoever asked, which makes it theirs to
        // deal with; this handle only remembers it, so that it is dropped with this one.
        this.markTransient(value);
        return value;
      };
    }
  }
}
