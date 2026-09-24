// ── defineActor types ────────────────────────────────────────────────────────
//
// Shared between define-actor.ts (implementation) and consumers that want
// to reference the config/context/definition shapes without importing the
// implementation module directly.

import type { SenderInfo, AsyncProcessFn, Message, ProcessCtx, ExitMessage, ForkSite } from "./types.js";
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
/**
 * A reflection method, async by contract: it answers with a promise, even when
 * it has the answer already.  The same call has to read the same way whether the
 * actor is here or behind a wire, and a caller that had to know which of the two
 * it was holding would be reading the shape of the deployment, not the answer.
 *
 * The parameters are `never` because nothing is called through this type — it is
 * the contract every declared method is checked against.
 */
export type ReflectionMethod = (...args: never[]) => Promise<unknown>;
/** The reflection surface a process exposes: named methods, each of them async
 *  by {@link ReflectionMethod}'s contract. */
export interface ReflectionOptions {
  [name: string]: ReflectionMethod;
}
export type Paired<Priv, Pub> = { public: Pub; private: Priv };
export type HidePrivate<T> = T extends Paired<unknown, unknown> ? T["public"] : T;

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
      toParent?: (msg: OutMsg, from: SenderInfo) => void;
      addPlugins?: ActorPlugin[];
      parentName?: string | null;
      parentId?: symbol | null;
      /** Wait for the initial state before resolving.  Default `true`. */
      awaitReady?: boolean;
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
  spawnAsChild(
    ctx: ForkSite,
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
/**
 * The config object as a user writes it.
 *
 * Hooks take their `this` from the `ThisType` at the end of this type: a per-hook
 * annotation erases the inferred methods surface.  `beforeStart` and `setup` keep
 * one, for the state.
 */
export type ActorConfig<
  Args,
  InternalState,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  Handlers extends HandlerOptions<InMsg>,
  ReflectionMethods extends ReflectionOptions,
> = {
  /** Preferred process name.  Used by ctx.fork() when no explicit name is given. */
  name?: string;
  plugins?: ActorPlugin[] | PluginTransform;
  /** Non-overridable plugins added at spawn time (spawn/fork opts).
   *  Set by the framework during assembly, not by user config. @internal */
  addPlugins?: ActorPlugin[];
  /** Resolved plugin chain (raw config transformed against parent plugins).
   *  Set by the framework during assembly, replacing `plugins` (the raw form).
   *  @internal */
  resolvedPlugins?: ActorPlugin[];
  outMessages?: ActorMessages<OutMsg>;
  inMessages?: ActorMessages<InMsg>;
  /** Fires once `self` is built, before `setup`.  State is not yet set
   *  (`this.state` is `never`).  Use for registering the process/ctx before
   *  any child is forked in `setup`. */
  beforeStart?: (
    this: ActorContext<
      Args,
      never,
      InMsg,
      OutMsg,
      MethodOptions,
      Handlers,
      ReflectionMethods & ActorReflection
    >,
  ) => void | Promise<void>;

  /** `this.state` is `never`: the returned value is the state. */
  setup?: (
    this: ActorContext<
      Args,
      never,
      InMsg,
      OutMsg,
      MethodOptions,
      Handlers,
      ReflectionMethods & ActorReflection
    >,
    args: Args,
  ) => Promise<InternalState> | InternalState;

  afterStart?: () => void | Promise<void>;

  onStopRequested?: () => HookResult | Promise<HookResult>;

  beforeEnd?: (reason?: unknown) => HookResult | Promise<HookResult>;

  /**
   * Runs once the actor has ended — after its EXIT.  It is *not* called when the
   * actor never started (`setup()` or a pre-start hook threw): the state is
   * typed as present here, and an actor that never got one has nothing to end.
   */
  afterEnd?: (reason?: unknown) => HookResult | Promise<HookResult>;

  onError?: (error?: unknown) => HookResult | ErrorResult | Promise<HookResult | ErrorResult>;

  onEmit?: (msg: OutMsg, sender: SenderInfo) => HookResult | Promise<HookResult>;

  onMessage?: (msg: InMsg, sender: SenderInfo) => HookResult | Promise<HookResult>;

  onUnhandled?: (msg: Message, sender: SenderInfo) => void | Promise<void>;

  /** A child ended.  `exit` is what it sent — its orphans travel there — and `reason` is what it
   *  ended *for*: the value `exit(reason)` was given, `"stopped"` for a stop that was agreed to,
   *  `CHANNEL_LOST` when the wire under a proxy went, or undefined when nobody asked. */
  onChildExit?: (
    name: string,
    exit: ExitMessage,
    reason: unknown,
  ) => HookResult | Promise<HookResult>;

  /** Fires for each orphan a child leaves behind (in its EXIT).  Return the
   *  policy: `'adopt'` (promote to a child, draining its buffer), `'force-stop'`
   *  (hard-kill), `'unparent'` (drop its buffer, keep it running in `orphans`),
   *  or `'leave'` (keep buffering, propagate up on my exit).  When no `onOrphan`
   *  is defined, the default is `'force-stop'`. */
  onOrphan?: (orphan: AnyProcess) => OrphanDecision | void | Promise<OrphanDecision | void>;

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
} & ThisType<
  ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers, ReflectionMethods & ActorReflection>
>;
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

/**
 * Returned by an `onError` handler that only *observed* the error — logged it,
 * counted it — and did not handle it.  The framework then lets the error
 * propagate: the actor still goes down and its parent still gets the EXIT.
 * Without this an observing handler (the bundled debug logger is one) silently
 * turns a broken lifecycle hook into a survivor with nothing left to do.
 */
export const PROPAGATE_SENTINEL = Symbol("posipaki.propagateError");

/** Type-safe sentinel for an onError handler that did not handle the error. */
export const propagateError = (): typeof PROPAGATE_SENTINEL => PROPAGATE_SENTINEL;

/** Return type of onError handlers: void (handled) or sentinel (not handled). */
export type ErrorResult = void | typeof PROPAGATE_SENTINEL;

// ── hook function types ──────────────────────────────────────────────────

/** Return type of onMessage hooks: void (continue) or sentinel (stop). */
export type HookResult = void | typeof STOP_SENTINEL;

/** Decision returned by `onOrphan` for how to handle an inherited orphan. */
export type OrphanDecision = "adopt" | "force-stop" | "unparent" | "leave";
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
    /** This actor as a process: the handle another process can be given so that it can
     *  send here.  There is no other way to obtain one — a process is reachable because
     *  somebody holds it, and this is how it hands itself over.  The same object as
     *  `ctx.self`, and as the one a spawner, a parent or a remote handle stands for.
     *  Erased, like every handle that leaves: whoever receives it declares what it is. */
    self: AsyncProcess<
      Args,
      HidePrivate<InternalState>,
      InMsg,
      OutMsg,
      ReflectionMethods & ActorReflection
    >;

    emit: (msg: OutMsg) => void;
    agreeToStop: () => void;

    reflection: ThisType<
      ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers, ReflectionMethods>
    > &
      ReflectionMethods;
    exit: (reason?: unknown) => void;

    $child: Record<string, AnyProcess>;

    fork<A, S, IM extends Message, OM extends InMsg, R extends ReflectionOptions>(
      actor: ActorDefinition<A, S, IM, OM, R>,
      args?: A,
      opts?: {
        name?: string;
        addPlugins?: ActorPlugin[];
      },
    ): Promise<AsyncProcess<A, HidePrivate<S>, IM, OM, R & ActorReflection>>;

    ctx: ProcessCtx<Args, HidePrivate<InternalState>, InMsg, OutMsg>;
  };



/**
 * The context a config's hooks are typed against, for a `Partial<>` overlay:
 * a mapped type drops the marker `ActorConfig` carries.
 */
export type ActorContextOf<C> = C extends ActorConfig<
  infer Args,
  infer InternalState,
  infer InMsg extends Message,
  infer OutMsg extends Message,
  infer Methods extends MethodOptions,
  infer Handlers,
  infer ReflectionMethods extends ReflectionOptions
>
  ? ActorContext<
      Args,
      InternalState,
      InMsg,
      OutMsg,
      Methods,
      Handlers extends HandlerOptions<InMsg> ? Handlers : HandlerOptions<InMsg>,
      ReflectionMethods & ActorReflection
    >
  : never;
