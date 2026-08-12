// ── defineActor types ────────────────────────────────────────────────────────
//
// Shared between define-actor.ts (implementation) and consumers that want
// to reference the config/context/definition shapes without importing the
// implementation module directly.

import type {
  SenderInfo,
  WithSender,
  AsyncProcessFn,
  Message,
  ProcessCtx,
  ExitMessage,
} from "./types.js";
import type { ActorDecorated, ActorReflection } from "./hooks.js";
import type { AnyProcess, AsyncProcess } from "./process.async.js";

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
export type ReflectionMethod = (...args: unknown[]) => unknown;
export interface ReflectionOptions {}
export type Paired<Priv, Pub> = { public: Pub; private: Priv };
export type HidePrivate<T> =
  T extends Paired<unknown, unknown> ? T["public"] : T;

export type SpawnedFrom<T extends ActorDefinition<any, any, any, any, any>> =
  T extends ActorDefinition<infer A, infer S, infer IM, infer OM, infer R>
    ? AsyncProcess<A, HidePrivate<S>, IM, OM, R & ActorReflection>
    : never;

export interface ActorDefinition<
  Args,
  InternalState,
  InMsg extends Message,
  OutMsg extends Message,
  ReflectionMethods extends ReflectionOptions,
> {
  fn: AsyncProcessFn<Args, HidePrivate<InternalState>, InMsg, OutMsg>;
  /** Preferred process name (from config.name). */
  name?: string;
  /** Raw plugin config (array or transform). Resolved at fork time. @internal */
  pvtPluginsRaw?: ActorPlugin[] | PluginTransform;
  /** Spawn this actor as a standalone process. */
  spawn(
    args: Args,
    opts?: {
      name?: string;
      toParent?: (msg: WithSender<OutMsg>) => void;
      addPlugins?: ActorPlugin[];
    },
  ): Promise<
    AsyncProcess<
      Args,
      HidePrivate<InternalState>,
      InMsg,
      OutMsg,
      ReflectionMethods & ActorReflection
    >
  >;
  /** Spawn this actor as a child of the calling process.
   *  `ctx` must be able to fork children that emit `OutMsg` — i.e. the
   *  parent's in-message is a supertype of this actor's out-message. */
  spawnAsChild<PMO extends Message>(
    ctx: ProcessCtx<unknown, unknown, OutMsg, PMO>,
    args: Args,
    opts?: {
      name?: string;
      parentPlugins?: ActorPlugin[];
      addPlugins?: ActorPlugin[];
    },
  ): Promise<
    AsyncProcess<
      Args,
      HidePrivate<InternalState>,
      InMsg,
      OutMsg,
      ReflectionMethods & ActorReflection
    >
  >;
  inMessages: ActorMessages<InMsg> | undefined;
  outMessages: ActorMessages<OutMsg> | undefined;
}
export type ActorConfig<
  Args,
  InternalState,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  Handlers extends HandlerOptions<InMsg>,
  ReflectionMethods extends ReflectionOptions,
> = ThisType<
  ActorContext<
    Args,
    InternalState,
    InMsg,
    OutMsg,
    Methods,
    Handlers,
    ReflectionMethods & ActorReflection
  >
> & {
  /** Preferred process name.  Used by ctx.fork() when no explicit name is given. */
  name?: string;
  plugins?: ActorPlugin[] | PluginTransform;
  outMessages?: ActorMessages<OutMsg>;
  inMessages?: ActorMessages<InMsg>;

  setup?: (
    this: ActorContext<
      Args,
      never,
      InMsg,
      OutMsg,
      Methods,
      Handlers,
      ReflectionMethods & ActorReflection
    >,
    args: Args,
  ) => Promise<InternalState> | InternalState;
  afterStart?: () => void | Promise<void>;
  onStopRequested?: () => HookResult | Promise<HookResult>;
  onEnd?: (reason?: unknown) => HookResult | Promise<HookResult>;
  onError?: (error?: unknown) => HookResult | Promise<HookResult>;
  onEmit?: (
    msg: OutMsg,
    sender: SenderInfo,
  ) => HookResult | Promise<HookResult>;

  onMessage?: (
    msg: InMsg,
    sender: SenderInfo,
  ) => HookResult | Promise<HookResult>;

  onUnhandled?: (msg: Message, sender: SenderInfo) => void | Promise<void>;

  onChildExit?: (
    name: string,
    reason: ExitMessage,
  ) => HookResult | Promise<HookResult>;

  handlers: Handlers &
    ThisType<
      ActorContext<
        Args,
        InternalState,
        InMsg,
        OutMsg,
        Methods,
        Handlers,
        ReflectionMethods & ActorReflection
      >
    >;

  methods?: Methods &
    ThisType<
      ActorContext<
        Args,
        InternalState,
        InMsg,
        OutMsg,
        Methods,
        Handlers,
        ReflectionMethods & ActorReflection
      >
    >;
  $reflectionMethods?: ReflectionMethods &
    ThisType<
      ActorContext<
        Args,
        InternalState,
        InMsg,
        OutMsg,
        Methods,
        Handlers,
        ActorReflection & ActorReflection
      >
    >;
  // for plugin use only
  $decorate?: Partial<ActorDecorated>;
};
export type AnyConfig = ActorConfig<
  unknown,
  unknown,
  Message,
  Message,
  MethodOptions,
  HandlerOptions<Message>,
  ReflectionOptions
>;

// ── stop propagation sentinel ────────────────────────────────────────────

/** Returned by onMessage hooks to prevent further dispatch. */
export const STOP_SENTINEL = Symbol("posipaki.stopPropagation");

/** Type-safe sentinel for short-circuiting onMessage hooks. */
export const stopPropagation = (): typeof STOP_SENTINEL => STOP_SENTINEL;

// ── hook function types ──────────────────────────────────────────────────

/** Return type of onMessage hooks: void (continue) or sentinel (stop). */
export type HookResult = void | typeof STOP_SENTINEL;
// ── plugin types ─────────────────────────────────────────────────────────

/** A reusable unit of actor behaviour. */
export type ActorPlugin<C = AnyConfig> = (config: C) => C | Promise<C>;

/** Transform parent plugins into child plugins. */
export type PluginTransform = (parentPlugins: ActorPlugin[]) => ActorPlugin[];

export type ActorContext<
  Args,
  InternalState,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  Handlers extends HandlerOptions<InMsg>,
  ReflectionMethods extends ReflectionOptions,
> = Methods &
  ActorDecorated & {
    state: InternalState;
    name: string;
    id: symbol;

    emit: (msg: OutMsg) => void;
    agreeToStop: () => void;

    reflection: ThisType<
      ActorContext<
        Args,
        InternalState,
        InMsg,
        OutMsg,
        Methods,
        Handlers,
        ReflectionMethods
      >
    > &
      ReflectionMethods;
    exit: (reason?: unknown) => void;

    $child: Record<string, AnyProcess>;

    fork<
      A,
      S,
      IM extends Message,
      OM extends InMsg,
      R extends ReflectionOptions,
    >(
      actor: ActorDefinition<A, S, IM, OM, R>,
      args?: A,
      opts?: {
        name?: string;
      },
    ): Promise<AsyncProcess<A, HidePrivate<S>, IM, OM, R>>;

    ctx: ProcessCtx<Args, HidePrivate<InternalState>, InMsg, OutMsg>;
  };
