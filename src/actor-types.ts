// ── defineActor types ────────────────────────────────────────────────────────
//
// Shared between define-actor.ts (implementation) and consumers that want
// to reference the config/context/definition shapes without importing the
// implementation module directly.

import type {
  AsyncProcessFn,
  Message,
  ProcessCtx,
  ExitMessage,
  StopMessage,
} from "./types.js";
import type { AsyncProcess } from "./process.async.js";

// Internal marker do not use
export type ActorMessages<M extends Message> = {
  __tag_messages: M;
};
export interface MethodOptions {
  [key: string]: Function;
}
export type HandlerFn<InMsg extends Message> = (
  msg: InMsg,
) => void | Promise<void>;
export type HandlerOptions<InMsg extends Message> = Omit<
  {
    [K in InMsg["type"]]: HandlerFn<Extract<InMsg, { type: K }>>;
  },
  "STOP"
>;

export interface ActorDefinition<
  Args,
  ExposedState,
  InMsg extends Message,
  OutMsg extends Message,
  Handlers extends HandlerOptions<InMsg>,
> {
  fn: AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>;
  config: ActorConfig<Args, any, ExposedState, InMsg, OutMsg, {}, Handlers>;
}

export interface ActorConfig<
  Args,
  InternalState,
  ExposedState,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  Handlers extends HandlerOptions<InMsg>,
> {
  initialState: InternalState | ((this: void, args: Args) => InternalState);
  expose?: (internalState: InternalState) => ExposedState;
  outMessages?: ActorMessages<OutMsg>;
  inMessages?: ActorMessages<InMsg>;

  onStart?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    args: Args,
  ) => void | Promise<void>;

  onStopRequested?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
  ) => void | Promise<void>;

  onEnd?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    reason?: unknown,
  ) => void | Promise<void>;

  handlers: Handlers &
    ThisType<
      ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>
    >;

  methods?: Methods &
    ThisType<
      ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>
    >;

  onUnhandled?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    msg: InMsg,
  ) => void | Promise<void>;

  onChildExit?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    name: string,
    reason: ExitMessage,
  ) => void | Promise<void>;
}

export type ActorContext<
  Args,
  InternalState,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  Handlers extends HandlerOptions<InMsg>,
> = Methods & {
  state: InternalState;
  name: string;
  id: symbol;

  emit: (msg: OutMsg) => void;
  agreeToStop: () => void;
  exit: (reason?: unknown) => void;

  $child: Record<string, AsyncProcess<unknown, unknown, Message, Message>>;

  fork<
    A,
    S,
    IM extends Message,
    OM extends Message,
    H extends HandlerOptions<IM>,
  >(
    fn: AsyncProcessFn<A, S, IM, OM> | ActorDefinition<A, S, IM, OM, H>,
    name: string,
    args?: A,
  ): AsyncProcess<A, S, IM, OM>;

  ctx: ProcessCtx<Args, InternalState, InMsg, OutMsg>;
};
