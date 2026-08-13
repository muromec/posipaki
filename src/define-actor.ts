// ── defineActor — high-level actor wrapper ───────────────────────────────────
//
// Compiles a declarative config into an AsyncProcessFn.  Built on top of
// the existing runDispatchAsync / spawnAsync primitives.
//
import {
  type AsyncProcess,
  runDispatchAsync,
  spawnAsync,
  AnyProcess,
} from "./process.async.js";
import type {
  WithSender,
  AsyncProcessFn,
  Message,
  ExitMessage,
  ProcessCtx,
} from "./types.js";
import type {
  ActorDefinition,
  ActorConfig,
  ActorContext,
  MethodOptions,
  ActorMessages,
  HandlerOptions,
  HandlerFn,
  ReflectionOptions,
  AnyConfig,
  HidePrivate,
} from "./actor-types.js";
import { STOP_SENTINEL } from "./actor-types.js";
import {
  ActorDecorated,
  type ActorPlugin,
  ActorReflection,
  callHook,
} from "./hooks.js";

export function defineMessages<
  OutMsg extends Message = Message,
>(): ActorMessages<OutMsg> {
  return undefined as unknown as ActorMessages<OutMsg>;
}

function hidePrivate<T>(value: T): HidePrivate<T> {
  if (
    value &&
    typeof value === "object" &&
    "private" in value &&
    "public" in value
  ) {
    return value.public as HidePrivate<T>;
  }
  return value as HidePrivate<T>;
}

function resolvePlugins(
  raw: ActorPlugin[] | ((parents: ActorPlugin[]) => ActorPlugin[]) | undefined,
  parentPlugins?: ActorPlugin[],
  addPlugins?: ActorPlugin[],
): ActorPlugin[] {
  const resolved =
    !raw ? (parentPlugins ? [...parentPlugins] : [])
    : Array.isArray(raw) ? [...raw]
    : raw(parentPlugins ?? []);

  const combined = addPlugins ? [...resolved, ...addPlugins] : resolved;

  // Deduplicate by function name
  const seen = new Set<string>();
  return combined.filter((p) => {
    const name = p.name;
    if (!name) {
      console.warn("posipaki: plugin has no name, dedup won't work");
      return true;
    }
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

async function assembleActor<C>(config: C, plugins: ActorPlugin[], addPlugins?: ActorPlugin[]): Promise<C> {
  // Work with the default ActorPlugin type internally, cast back on return
  let cur = config as AnyConfig;
  for (const p of plugins) {
    try {
          cur = await p(cur);
    } catch (e: unknown) {
      console.error(
        `[assembleActor] plugin "${p.name || "?"}" failed:`,
        e,
      );
    }
  }
  cur.resolvedPlugins = plugins;
  if (addPlugins) cur.addPlugins = addPlugins;
  return cur as C;
}

export function defineActor<
  Args,
  InternalState,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  Handlers extends HandlerOptions<InMsg>,
  ReflectionMethods extends ReflectionOptions,
>(
  config: ActorConfig<
    Args,
    InternalState,
    InMsg,
    OutMsg,
    Methods,
    Handlers,
    ReflectionMethods
  >,
): ActorDefinition<Args, InternalState, InMsg, OutMsg, ReflectionMethods> {
  const actorCtxMap = new Map<
    symbol,
    ActorContext<
      Args,
      InternalState,
      InMsg,
      OutMsg,
      Methods,
      Handlers,
      ReflectionMethods
    >
  >();

  function makeRuntime(
    assembly: ActorConfig<
      Args,
      InternalState,
      InMsg,
      OutMsg,
      Methods,
      Handlers,
      ReflectionMethods
    >,
  ): AsyncProcessFn<Args, HidePrivate<InternalState>, InMsg, OutMsg> {
    return async function* (
      ctx,
      args,
    ): AsyncGenerator<
      HidePrivate<InternalState | null>,
      void,
      WithSender<InMsg>
    > {
      let done = false;
      let exitReason: unknown;
      let rawState: InternalState = undefined as unknown as InternalState;

      const decorated = new Map();
      const self: ActorContext<
        Args,
        InternalState,
        InMsg,
        OutMsg,
        Methods,
        Handlers,
        ReflectionMethods & ActorReflection
      > = {
        ctx,
        ...((assembly.methods || {}) as Methods),
        ...((assembly.$decorate || {}) as ActorDecorated),
        reflection: {} as ReflectionMethods & ActorReflection,
        state: rawState,
        name: ctx.pname,
        id: ctx.id,
        async emit(msg: OutMsg) {
          await callHook(assembly.onEmit, undefined, self, msg, {
            fromName: ctx.pname,
            fromId: ctx.id,
          });
          ctx.toParent(msg);
        },
        agreeToStop() {
          exitReason = "stopped";
          done = true;
        },
        exit(reason: unknown) {
          exitReason = reason;
          done = true;
        },
        $child: {} as Record<string, AnyProcess>,
        decorators: {},
        fork: async <
          A,
          S,
          IM extends Message,
          OM extends InMsg,
          R extends ReflectionOptions,
        >(
          childActor: ActorDefinition<A, S, IM, OM, R>,
          childArgs?: A,
          forkOpts?: { name?: string; addPlugins?: ActorPlugin[] },
        ): Promise<AsyncProcess<A, HidePrivate<S>, IM, OM, R & ActorReflection>> => {
          let child: AsyncProcess<A, HidePrivate<S>, IM, OM, R & ActorReflection>;
          const childName =
            forkOpts?.name ??
            childActor?.name ??
            `child-${Object.keys(self.$child).length}`;
          const treeName = `${ctx.pname}:${childName}`;
          const childAddPlugins = [
            ...(assembly.addPlugins || []),
            ...(forkOpts?.addPlugins || []),
          ];
          child = await childActor.spawnAsChild(
            ctx,
            childArgs!,
            {
              name: treeName,
              parentPlugins: assembly.resolvedPlugins || [],
              ...(childAddPlugins.length ? { addPlugins: childAddPlugins } : {}),
            },
          );
          self.$child[child.pname] = child as unknown as AnyProcess;
          return child;
        },
      };
      actorCtxMap.set(ctx.id, self);

      for (const [k, v] of decorated) {
        (self as Record<string, unknown>)[k] = v;
      }

      if (assembly.beforeStart) {
        await callHook(
          assembly.beforeStart,
          assembly.onError,
          self as ActorContext<
            Args,
            never, // state not set yet
            InMsg,
            OutMsg,
            Methods,
            Handlers,
            ReflectionMethods & ActorReflection
          >,
        );
      }

      if (assembly.setup) {
        rawState = await assembly.setup.call(
          self as ActorContext<
            Args,
            never, // break inference cycle here
            InMsg,
            OutMsg,
            Methods,
            Handlers,
            ReflectionMethods & ActorReflection
          >,
          args,
        );
      } else {
        rawState = null as InternalState;
      }
      self.state = rawState;
      yield hidePrivate(rawState);
      await callHook(assembly.afterStart, assembly.onError, self);

      yield* runDispatchAsync<WithSender<InMsg | ExitMessage>>(
        ctx.pname,
        async (stamped) => {
          const [msg, sender] = stamped;
          if (msg.type === "STOP") {
            if (assembly.onStopRequested) {
              await callHook(assembly.onStopRequested, assembly.onError, self);
              // Hook may call agreeToStop(). If not, actor keeps running.
            } else {
              exitReason = "stopped";
              done = true;
            }
            return;
          }
          if (msg.type === "EXIT") {
            const childName = sender.fromName;
            if (childName && self.$child[childName]) {
              delete self.$child[childName];
            }
            await callHook(
              assembly.onChildExit,
              assembly.onError,
              self,
              childName,
              msg as ExitMessage,
            );
          }
          let hookStopped = false;
          if (
            msg.type !== "STOP" &&
            msg.type !== "EXIT" &&
            assembly.onMessage
          ) {
            const result = await callHook(
              assembly.onMessage,
              assembly.onError,
              self,
              msg as InMsg,
              sender,
            );
            if (result === STOP_SENTINEL) hookStopped = true;
          }
          if (msg.type !== "STOP" && !hookStopped) {
            const handler =
              ((assembly.handlers || ({} as Handlers))[
                msg.type as keyof Handlers
              ] as HandlerFn<InMsg>) || assembly.onUnhandled;

            await callHook(
              handler,
              assembly.onError,
              self,
              msg as InMsg,
              sender,
            );
          }
        },
        () => done,
      );

      await callHook(assembly.onEnd, assembly.onError, self, exitReason);
    };
  }

  type ReflectableProcess = {
    id: symbol;
    $reflection: Record<string, Function>;
  };
  function attachReflection(
    proc: ReflectableProcess,
    reflectionMethods: ReflectionMethods | undefined,
  ): void {
    if (!reflectionMethods) return;
    const self = actorCtxMap.get(proc.id);
    const refl = proc.$reflection as Record<string, Function>;
    for (const [k, m] of Object.entries(reflectionMethods)) {
      refl[k] = m.bind(self);
    }
  }

  return {
    fn: makeRuntime(config),
    name: config.name,
    pvtPluginsRaw: config.plugins,
    inMessages: config.inMessages,
    outMessages: config.outMessages,
    async spawn(
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
    > {
      const plugs = resolvePlugins(config.plugins, undefined, opts?.addPlugins);
      const assembly = await assembleActor(config, plugs, opts?.addPlugins);
      const runtime = makeRuntime(assembly);
      const proc = spawnAsync(runtime, opts?.name ?? assembly.name ?? "actor", opts?.toParent)(args);
      attachReflection(proc, assembly.$reflectionMethods as ReflectionMethods);
      return proc as AsyncProcess<
        Args,
        HidePrivate<InternalState>,
        InMsg,
        OutMsg,
        ReflectionMethods & ActorReflection
      >;
    },
    async spawnAsChild(
      ctx: ProcessCtx<unknown, unknown, OutMsg, Message>,
      args: Args,
      opts?: {
        name?: string;
        parentPlugins?: ActorPlugin[];
        addPlugins?: ActorPlugin[];
      },
    ) {
      const plugs = resolvePlugins(config.plugins, opts?.parentPlugins, opts?.addPlugins);
      const assembly = await assembleActor(config, plugs, opts?.addPlugins);
      const runtime = makeRuntime(assembly);
      const proc = ctx.fork(runtime, opts?.name ?? assembly.name ?? "child")(args);
      attachReflection(proc, assembly.$reflectionMethods as ReflectionMethods);
      return proc as AsyncProcess<
        Args,
        HidePrivate<InternalState>,
        InMsg,
        OutMsg,
        ReflectionMethods & ActorReflection
      >;
    },
  };
}
