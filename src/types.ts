/**
 * Public API types for Posipaki.
 *
 * @module
 */
import type { AsyncProcess, AnyProcess } from "./process.async.js";

// ---- Message -----------------------------------------------------------------

/** Base message type. All messages must include a `type` field
 * for discrimination in reducers. */
export interface Message {
  type: string;
}

// ---- SenderInfo --------------------------------------------------------------

/** Sender identity.  `fromName` is the process name, `fromId` its symbol. */
export interface SenderInfo {
  fromName: string;
  fromId: symbol;
}

// ---- WithSender / WithoutSender -----------------------------------------------

/** A message paired with its sender.  This is the currency inside the
 *  framework — every message in the buffer and every value the generator
 *  receives is `WithSender<M>`. */
export type WithSender<M extends Message> = [M, SenderInfo];

/** Extract the message type from a stamped tuple. */
export type WithoutSender<T extends WithSender<any>> = T[0];

// ---- ExitMessage -------------------------------------------------------------

/** Message emitted by a process to its parent when it terminates.
 *  The sender's identity is carried in the {@link SenderInfo} tuple. */
export type ExitMessage = {
  type: "EXIT";
  /** Why it ended, when it said: what `ActorContext.exit(reason)` was given, or the word for a
   *  stop that was agreed to.  Absent for an end nobody asked for — a process that died of a
   *  throw reports that as the failure it is, and not as a reason here. */
  reason?: unknown;
  /** Still-running children of the exiting process, handed up to the parent
   *  for adoption (in-process only). */
  orphans?: Array<AnyProcess>;
};

export type StopMessage = {
  type: "STOP";
};

// ---- ProcessFn (sync) -------------------------------------------------------

export type ProcessFn<Args, State, InMessage extends Message, OutMessage extends Message> = (
  ctx: ProcessCtx<Args, State, InMessage, OutMessage>,
  args: Args,
) => Generator<State | null, void, WithSender<InMessage | StopMessage>>;

// ---- ProcessFn (async) ------------------------------------------------------

export type AsyncProcessFn<
  Args,
  State,
  InMessage extends Message = Message,
  OutMessage extends Message = Message,
> = (
  ctx: ProcessCtx<Args, State, InMessage, OutMessage>,
  args: Args,
) => AsyncGenerator<State | null, void, WithSender<InMessage | StopMessage>>;

// ---- Sender ----------------------------------------------------------------

/** Origin of a message — either a process context or the literal "root"
 *  (used by the system harness to inject messages from outside). */
export type SenderOrigin = ProcessCtx<unknown, unknown, Message, Message> | "root";

// ---- FrameChannel ----------------------------------------------------------

/**
 * The frames of a connection, as the process that holds it sees them.
 *
 * A process may hold one (`ctx.connection`): the connection it was spawned on, or one it
 * opened for itself.  `send` puts a frame on it, `onMessage` takes them off, `onClose` is
 * told the far end is gone, and `close` ends it.  Nothing here knows a protocol: a frame is
 * a decoded object, and what its keys mean belongs to whoever wrote them.
 *
 * One connection can carry several readers: `onMessage` subscribes and returns the function that
 * unsubscribes, so what a process holds as `ctx.connection` is the same thing the seam speaks, and a
 * caller reads frames without taking them away from whoever else is reading.
 */
export interface FrameChannel {
  send(frame: Record<string, unknown>): void | Promise<void>;
  onMessage(handler: (frame: Record<string, unknown>) => void): () => void;
  /** Fires when the peer disconnects (the connection closes from the other side). */
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

// ---- ProcessCtx -------------------------------------------------------------

type ProcessMessageCb<M> = (msg: M) => void;

/** Fork a child process. Takes a ProcessFn and a name, returns a
 *  curried function that accepts the child's initial args. */
export type Fork<ChildArgs, ChildState, ChildIM extends Message, ChildOM extends Message> = (
  fn: AsyncProcessFn<ChildArgs, ChildState, ChildIM, ChildOM>,
  pname: string,
) => (args: ChildArgs) => AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM, {}>;

export type ForkSync<ChildArgs, ChildState, ChildIM extends Message, ChildOM extends Message> = (
  fn: ProcessFn<ChildArgs, ChildState, ChildIM, ChildOM>,
  pname: string,
) => (args: ChildArgs) => AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM, {}>;

/** Context injected into every running process. */
export type ProcessCtx<Args, State, IM extends Message, OM extends Message> = {
  pname: string;
  id: symbol;
  /**
   * This process, as the thing others address: the handle that makes it reachable
   * rather than merely named.  A name and a symbol say who a message came from; only a
   * handle can be sent to, so this is what a process hands over when it says "here I
   * am" — put it in a message body and whoever receives it can talk back, locally or
   * across a seam, where the reference crosses like any other.
   *
   * It is the process itself, not a copy of its identity: `self.pname` and `self.id` are
   * this ctx's, and `sendSelf` is the same act through a narrower door.  Typed as a handle
   * is typed everywhere it crosses (`children`, a message body): the ctx's generics are
   * this process's own, and what a reference is passed *to* is declared by whoever
   * receives it, not by whoever hands it over.
   */
  self: AsyncProcess<Args, State, IM, OM, {}>;
  parentName: string | null;
  parentId: symbol | null;
  /**
   * The connection this process holds, or null.  Set where the connection is made: the
   * spawner states it (`spawn(args, { connection })`, so it is there from `setup` on), and
   * a process that opens one for itself writes it here — the proxy at the client end of a
   * remote actor is the one that does.  A process with no connection reads null.
   */
  connection: FrameChannel | null;
  sendSelf: (msg: IM | StopMessage) => void;
  toParent: ProcessMessageCb<OM | ExitMessage>;
  /** Fire this process's state subscribers now (no message round-trip).
   *  Used when something outside the dispatch loop — e.g. a remote $state
   *  frame — mutates `state` and the change must still be observed. */
  notify: () => void;
  /** Resume a dispatch loop that is parked at its yield so it can notice a
   *  flag set from outside the loop (see `ActorContext.exit()`).  No-op when
   *  the loop is already running, or the process is dead.  Internal. */
  wake: () => void;
  /** What this process is ending with, when the end was asked for: the `reason` it was exited
   *  with, or `"stopped"` for a stop it agreed to.  Read when EXIT goes to the parent, so the
   *  parent is told *why* and not only *that*.  Internal. */
  exitReason?: unknown;
  /** Invoked by the runtime after the process emits EXIT to its parent.
   *  Best-effort teardown that must not delay the exit signal. */
  afterExit?: () => Promise<void> | void;
} & Pick<
  AsyncProcess<Args, State, IM, OM, {}>,
  "fork" | "forkSync" | "children" | "orphans" | "adopt" | "monitor"
>;
export type AnyProcessCtx = ProcessCtx<unknown, unknown, Message, Message>;

// ---- ForkSite ----------------------------------------------------------------

/**
 * A place a process can be forked from: the parent's `fork`, and nothing else.
 *
 * This is what spawning a child needs of the process it is spawned under, and it is
 * deliberately not a `ProcessCtx`.  A context is typed by its own argument, state and
 * message shapes — with `self` in it, that is a type no other shape can be mistaken for —
 * while a child's spawn depends on exactly one of its members.  Naming the whole context
 * here would say the child's birth depends on the parent's shapes, which it does not, and
 * would leave `spawnAsChild` acceptable only from a context of the same shape as its own.
 *
 * The link that does matter — the child's out-messages reaching the parent's handlers — is
 * checked where the parent's own type is in hand: `this.fork(child)`, whose child's
 * out-messages must fit the parent's in-messages.
 */
export type ForkSite = Pick<ProcessCtx<unknown, unknown, Message, Message>, "fork">;

