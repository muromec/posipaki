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

/** Message emitted by a process to its parent when it terminates.
 *
 * On EXIT, `fromId` and `pid` carry the same symbol value.
 * `fromName` is the process name (same as `ctx.pname`).
 * These fields mirror what `this.emit()` / `ctx.toParent()` stamp on
 * normal messages, so callers can identify the sender of *any* child
 * message — application or EXIT — by reading `msg.fromName` or
 * `msg.fromId`. */
export type ExitMessage = {
  type: "EXIT";
  pid: symbol;
  fromName?: string;
  fromId?: symbol;
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
