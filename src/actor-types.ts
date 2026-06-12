// ── defineActor types ────────────────────────────────────────────────────────
//
// Shared between define-actor.ts (implementation) and consumers that want
// to reference the config/context/definition shapes without importing the
// implementation module directly.

import type { AsyncProcessFn, Message, ProcessCtx, ExitMessage } from "./types.js";
import type { AsyncProcess } from "./process.async.js";

export interface ActorDefinition<
  Args,
  ExposedState,
  InMsg extends Message,
  OutMsg extends Message,
> {
  fn: AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>;
  config: ActorConfig<Args, any, ExposedState, InMsg, OutMsg>;
}

export interface ActorConfig<
  Args,
  InternalState,
  ExposedState,
  InMsg extends Message,
  OutMsg extends Message,
> {
  initialState: InternalState | ((args: Args) => InternalState);
  expose?: (internalState: InternalState) => ExposedState;

  onStart?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    args: Args,
  ) => void | Promise<void>;

  onStopRequested?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
  ) => void | Promise<void>;

  onEnd?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    reason?: unknown,
  ) => void | Promise<void>;

  handlers: {
    [K in InMsg["type"]]?: (
      this: ActorContext<Args, InternalState, InMsg, OutMsg>,
      msg: Extract<InMsg, { type: K }>,
    ) => void | Promise<void>;
  };

  onUnhandled?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    msg: InMsg,
  ) => void | Promise<void>;

  onChildExit?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    name: string,
    reason: ExitMessage,
  ) => void | Promise<void>;
}

export interface ActorContext<
  Args,
  InternalState,
  InMsg extends Message,
  OutMsg extends Message,
> {
  state: InternalState;
  name: string;
  id: symbol;

  emit: (msg: OutMsg) => void;
  agreeToStop: () => void;
  exit: (reason?: unknown) => void;

  $child: Record<string, AsyncProcess<unknown, unknown, Message, Message>>;

  fork<A, S, IM extends Message, OM extends Message>(
    fn: AsyncProcessFn<A, S, IM, OM> | ActorDefinition<A, S, IM, OM>,
    name: string,
    args?: A,
  ): AsyncProcess<A, S, IM, OM>;

  ctx: ProcessCtx<Args, InternalState, InMsg, OutMsg>;
}
