// ── defineActor types ────────────────────────────────────────────────────────
//
// Shared between define-actor.ts (implementation) and consumers that want
// to reference the config/context/definition shapes without importing the
// implementation module directly.

import type {
  SenderInfo,
  AsyncProcessFn,
  Message,
  ProcessCtx,
  ExitMessage,
} from "./types.js";
import type { ActorDecorated } from "./hooks.js";
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
  sender: SenderInfo,
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
  // eslint-disable-next-line no-unused-vars
  Handlers extends HandlerOptions<InMsg>,
  ReflectionMethods = {},
> {
  fn: AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>;
  config: ActorConfig<Args, any, ExposedState, InMsg, OutMsg, {}, Handlers>;
  /** Preferred process name (from config.name). */
  name?: string;
  /** Raw plugin config (array or transform). Resolved at fork time. @internal */
  pvtPluginsRaw?: ActorPlugin[] | PluginTransform;
  /** Spawn this actor as a standalone process. */
  spawn(
    args: Args,
  ): Promise<
    AsyncProcess<Args, ExposedState, InMsg, OutMsg, ReflectionMethods>
  >;
  /** Spawn this actor as a child of the calling process. */
  spawnAsChild(
    ctx: ProcessCtx<any, any, any, any>,
    args: Args,
    name?: string,
    parentPlugins?: ActorPlugin[],
  ): Promise<
    AsyncProcess<Args, ExposedState, InMsg, OutMsg, ReflectionMethods>
  >;
}

export interface ActorHooksConfig<
  Args,
  InternalState,
  ExposedState,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  // eslint-disable-next-line no-unused-vars
  Handlers extends HandlerOptions<InMsg>,
> {
  onStart?: OnStartHook<ExposedState>;
  onMessage?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    msg: InMsg,
    sender: SenderInfo,
  ) => HookResult | Promise<HookResult>;
  onEmit?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    msg: OutMsg,
  ) => void;
  onChildExit?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    name: string,
  ) => void | Promise<void>;
  onStopRequested?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
  ) => void | Promise<void>;
  onEnd?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    reason: unknown,
  ) => void | Promise<void>;
  onError?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    err: unknown,
  ) => void;
}

export interface ActorConfig<
  Args,
  InternalState,
  ExposedState,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  // eslint-disable-next-line no-unused-vars
  Handlers extends HandlerOptions<InMsg>,
  ReflectionMethods = {},
> {
  initialState?:
    | InternalState
    | ((
        this: ActorContext<
          Args,
          InternalState,
          InMsg,
          OutMsg,
          Methods,
          Handlers
        >,
        args: Args,
      ) => InternalState);
  expose?: (internalState: InternalState) => ExposedState;
  /** Preferred process name.  Used by ctx.fork() when no explicit name is given. */
  name?: string;
  hooks?: ActorHooksConfig<
    Args,
    InternalState,
    ExposedState,
    InMsg,
    OutMsg,
    Methods,
    Handlers
  >;
  /** Plugins installed at fork time. Array = replace, function = transform parent chain. */
  plugins?: ActorPlugin[] | PluginTransform;
  outMessages?: ActorMessages<OutMsg>;
  inMessages?: ActorMessages<InMsg>;

  setup?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    args: Args,
  ) => InternalState | Promise<InternalState>;

  afterStart?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
  ) => void | Promise<void>;

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

  onError?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    error?: unknown,
  ) => void | Promise<void>;

  onEmit?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    msg: OutMsg,
    sender: SenderInfo,
  ) => void;

  onMessage?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    msg: InMsg,
    sender: SenderInfo,
  ) => void | Promise<void>;

  onUnhandled?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    msg: Message,
    sender: SenderInfo,
  ) => void | Promise<void>;

  onChildExit?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>,
    name: string,
    reason: ExitMessage,
  ) => void | Promise<void>;

  handlers: Handlers &
    ThisType<
      ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>
    >;

  methods?: Methods &
    ThisType<
      ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>
    >;
  $reflectionMethods?: ReflectionMethods &
    ThisType<
      ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>
    >;
}

// ── stop propagation sentinel ────────────────────────────────────────────

/** Returned by onMessage hooks to prevent further dispatch. */
export const STOP_SENTINEL = Symbol("posipaki.stopPropagation");

/** Type-safe sentinel for short-circuiting onMessage hooks. */
export const stopPropagation = (): typeof STOP_SENTINEL => STOP_SENTINEL;

// ── hook function types ──────────────────────────────────────────────────

/** Return type of onMessage hooks: void (continue) or sentinel (stop). */
export type HookResult = void | typeof STOP_SENTINEL;

export type OnStartHook<State> = (state: State) => void | Promise<void>;
export type OnMessageHook<InMsg extends Message> = (
  msg: InMsg,
  sender: SenderInfo,
) => HookResult | Promise<HookResult>;
export type OnEmitHook<OutMsg extends Message> = (msg: OutMsg) => void;
export type OnChildExitHook = (name: string) => void | Promise<void>;
export type OnStopRequestedHook = () => void | Promise<void>;
export type OnEndHook = (reason: unknown) => void | Promise<void>;
export type OnErrorHook = (err: unknown) => void;

// ── plugin types ─────────────────────────────────────────────────────────

/** A reusable unit of actor behaviour. */
export type ActorPlugin = (
  config: ActorConfig<
    unknown,
    unknown,
    Message,
    Message,
    Message,
    {},
    HandlerOptions<Message>
  >,
) =>
  | ActorConfig<
      unknown,
      unknown,
      Message,
      Message,
      Message,
      {},
      HandlerOptions<Message>
    >
  | Promise<
      ActorConfig<
        unknown,
        unknown,
        Message,
        Message,
        Message,
        {},
        HandlerOptions<Message>
      >
    >;

/** Transform parent plugins into child plugins. */
export type PluginTransform = (parentPlugins: ActorPlugin[]) => ActorPlugin[];

export type ActorContext<
  Args,
  InternalState,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  Handlers extends HandlerOptions<InMsg>,
> = Methods &
  ActorDecorated & {
    state: InternalState;
    name: string;
    id: symbol;

    emit: (msg: OutMsg) => void;
    agreeToStop: () => void;

    reflection: Record<
      string,
      (
        this: ActorContext<
          Args,
          InternalState,
          InMsg,
          OutMsg,
          Methods,
          Handlers
        >,
      ) => unknown
    >;
    decorators: Record<
      string,
      (
        this: ActorContext<
          Args,
          InternalState,
          InMsg,
          OutMsg,
          Methods,
          Handlers
        >,
      ) => unknown
    >;

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
      name?: string,
      args?: A,
    ): AsyncProcess<A, S, IM, OM> | Promise<AsyncProcess<A, S, IM, OM>>;

    ctx: ProcessCtx<Args, InternalState, InMsg, OutMsg>;
  };
