/**
 * Public API types for Posipaki.
 *
 * @module
 */
import type { AsyncProcess } from "./process.async";

// ---- Message -----------------------------------------------------------------

/** Base message type. All messages must include a `type` field
 * for discrimination in reducers. */
export interface Message {
  type: string;
}

/** Message with guaranteed sender provenance.
 *
 * `fromName` and `fromId` are stamped by the framework when a message
 * passes through `ctx.toParent()` or `ctx.send()`.  Messages arriving
 * via `proc.send()` from outside the process tree may not carry them. */
export interface InternalMessage extends Message {
  fromName: string;
  fromId: symbol;
}

/** Message emitted by a process to its parent when it terminates.
 *
 * `fromId` and `pid` carry the same symbol value.  `fromName` is the
 * process name (same as `ctx.pname`).  These fields mirror what
 * the framework stamps on every `ctx.toParent()` / `ctx.send()` call. */
export type ExitMessage = InternalMessage & {
  type: "EXIT";
  /** @deprecated Use {@link fromId} instead. */
  pid: symbol;
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
) => Generator<State | null, void, InMessage>;

// ---- ProcessFn (async) ------------------------------------------------------

export type AsyncProcessFn<
  Args,
  State,
  InMessage extends Message,
  OutMessage extends Message,
> = (
  ctx: ProcessCtx<Args, State, InMessage, OutMessage>,
  args: Args,
) => AsyncGenerator<State | null, void, InMessage>;

// ---- Sender ----------------------------------------------------------------

/** Origin of a message — either a process context or the literal "root"
 *  (used by the system harness to inject messages from outside). */
export type SenderOrigin =
  | ProcessCtx<unknown, unknown, Message, Message>
  | "root";

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
) => (args: ChildArgs) => AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM>;

export type ForkSync<
  ChildArgs,
  ChildState,
  ChildIM extends Message,
  ChildOM extends Message,
> = (
  fn: ProcessFn<ChildArgs, ChildState, ChildIM, ChildOM>,
  pname: string,
) => (args: ChildArgs) => AsyncProcess<ChildArgs, ChildState, ChildIM, ChildOM>;

/** Context injected into every running process. */
export type ProcessCtx<Args, State, IM extends Message, OM extends Message> = {
  pname: string;
  id: symbol;
  send: (msg: IM) => void;
  toParent: ProcessMessageCb<OM>;
} & Pick<AsyncProcess<Args, State, IM, OM>, "fork" | "forkSync">;

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

// ---- SenderInfo --------------------------------------------------------------

/** Sender identity extracted from an {@link InternalMessage} by
 *  the `defineActor` dispatch loop.  `fromName` is the process name,
 *  `fromId` its symbol. */
export interface SenderInfo {
  fromName: string;
  fromId: symbol;
}
