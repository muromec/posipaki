/**
 * Public API types for Posipaki.
 *
 * @module
 */

// ---- Message -----------------------------------------------------------------

/** Base message type. All messages must include a `type` field
 * for discrimination in reducers. */
export interface Message {
  type: string;
}

/** Message emitted by a process to its parent when it terminates. */
export type ExitMessage = {
  type: "EXIT";
  pid: symbol;
};

// ---- ProcessFn (sync) -------------------------------------------------------

export type ProcessFn<Args, State, InMessage extends Message, OutMessage extends Message> = (
  ctx: ProcessCtx<InMessage, OutMessage>,
  args: Args,
) => Generator<State | null, void, InMessage>;

// ---- ProcessFn (async) ------------------------------------------------------

export type AsyncProcessFn<Args, State, InMessage extends Message, OutMessage extends Message> = (
  ctx: ProcessCtx<InMessage, OutMessage>,
  args: Args,
) => AsyncGenerator<State | null, void, InMessage>;

// ---- ProcessCtx -------------------------------------------------------------

type ProcessMessageCb<M> = (msg: M) => void

/** Fork a child process. Takes a ProcessFn and a name, returns a
 *  curried function that accepts the child's initial args. */
export type Fork<_IM extends Message, _OM extends Message> = <CA, CS, CIM extends Message, COM extends Message>(
  fn: ProcessFn<CA, CS, CIM, COM>, pname: string,
) => (a: CA) => any // returns Process<CA, CS, CIM, COM> — circular

/** Context injected into every running process. */
export type ProcessCtx<IM extends Message, OM extends Message> = {
  pname: string
  fork: Fork<IM, OM>
  send: (msg: IM) => void
  toParent: ProcessMessageCb<OM>
}

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
