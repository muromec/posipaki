/**
 * Public API types for Posipaki.
 *
 * @module
 */
import type { AsyncProcess } from "./process.async.js";

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
};

export type StopMessage = {
  type: "STOP";
};

// ---- ProcessFn (sync) -------------------------------------------------------

export type ProcessFn<
  Args,
  State,
  InMessage extends Message,
  OutMessage extends Message,
> = (
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
export type SenderOrigin =
  ProcessCtx<unknown, unknown, Message, Message> | "root";

// ---- ProcessCtx -------------------------------------------------------------

type ProcessMessageCb<M> = (msg: M) => void;

/** Fork a child process. Takes a ProcessFn and a name, returns a
 *  curried function that accepts the child's initial args. */
export type Fork<
  ChildArgs,
  ChildState,
  ChildIM extends Message,
  ChildOM extends Message,
> = (
  fn: AsyncProcessFn<ChildArgs, ChildState, ChildIM, ChildOM>,
  pname: string,
) => (
  args: ChildArgs,
) => AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM, {}>;

export type ForkSync<
  ChildArgs,
  ChildState,
  ChildIM extends Message,
  ChildOM extends Message,
> = (
  fn: ProcessFn<ChildArgs, ChildState, ChildIM, ChildOM>,
  pname: string,
) => (
  args: ChildArgs,
) => AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM, {}>;

/** Context injected into every running process. */
export type ProcessCtx<Args, State, IM extends Message, OM extends Message> = {
  pname: string;
  id: symbol;
  parentName: string | null;
  parentId: symbol | null;
  sendSelf: (msg: IM | StopMessage) => void;
  toParent: ProcessMessageCb<OM>;
  /** Invoked by the runtime after the process emits EXIT to its parent.
   *  Best-effort teardown that must not delay the exit signal. */
  afterExit?: () => Promise<void> | void;
} & Pick<AsyncProcess<Args, State, IM, OM, {}>, "fork" | "forkSync" | "children">;
export type AnyProcessCtx = ProcessCtx<unknown, unknown, Message, Message>;

// ---- Pipe -------------------------------------------------------------------

/** State yielded by the pipe process. */
export interface PipeState<Params, Result> {
  params: Params | null;
  result: Result | null;
  running: boolean;
}

// ---- Supervisor -------------------------------------------------------------

/** State yielded by the supervisor process. */
export interface SupervisorState {
  processes: any[]; // Process<any,any,any,any>[]
  phase: "wait" | "running" | "stopping";
}
