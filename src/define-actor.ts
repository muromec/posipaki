// ── defineActor — high-level actor wrapper ───────────────────────────────────
//
// Compiles a declarative config into an AsyncProcessFn.  Built on top of
// the existing runDispatchAsync / spawnAsync primitives.
//
// Phase 2: assembly outside the generator, async spawn.

import { runDispatchAsync, spawnAsync } from "./process.async.js";
import type {
  WithSender,
  AsyncProcessFn,
  Message,
  ExitMessage,
  ProcessCtx,
} from "./types.js";
import type { AsyncProcess } from "./process.async.js";
import type {
  ActorDefinition,
  ActorConfig,
  ActorContext,
  MethodOptions,
  ActorMessages,
  HandlerOptions,
  HandlerFn,
} from "./actor-types.js";
import type { ActorPlugin } from "./hooks.js";

export function defineMessages<
  OutMsg extends Message = Message,
>(): ActorMessages<OutMsg> {
  return undefined as unknown as ActorMessages<OutMsg>;
}

function resolvePlugins(
  config: ActorConfig<
    unknown,
    unknown,
    Message,
    Message,
    Message,
    {},
    HandlerOptions<Message>
  >,
  parentPlugins?: ActorPlugin[],
): ActorPlugin[] {
  const raw = config.plugins;
  if (!raw) return parentPlugins ? [...parentPlugins] : [];
  if (Array.isArray(raw)) return [...raw];
  return raw(parentPlugins ?? []);
}

async function assembleActor(
  config: ActorConfig<
    unknown,
    unknown,
    Message,
    Message,
    Message,
    {},
    HandlerOptions<Message>
  >,
  plugins: ActorPlugin[],
): Promise<
  ActorConfig<
    unknown,
    unknown,
    Message,
    Message,
    Message,
    {},
    HandlerOptions<Message>
  >
> {
  for (const p of plugins) {
    try {
      config = await p(config);
    } catch (e: unknown) {
      console.error(
        `[assembleActor] plugin "${(p as Function).name || "?"}" failed:`,
        e,
      );
    }
  }
  return config;
}

type Hook<T, I extends unknown[], O> = (this: T, ...args: I) => O;

function callHook<T, I extends unknown[], O>(
  fn: Hook<T, I, O> | undefined,
  eh: ((e: unknown) => unknown) | undefined,
  thisArg: T,
  ...args: I
): (F extends Hook<T, I, O> ? O : undefined) | undefined {
  if (fn) {
    try {
      return fn.call(thisArg, ...args);
    } catch (e) {
      if (eh) {
        eh(e);
      }
    }
  }
}

export function defineActor<
  Args,
  InternalState,
  ExposedState,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  Handlers extends HandlerOptions<InMsg>,
  ReflectionMethods = {},
>(
  config: ActorConfig<
    Args,
    InternalState,
    ExposedState,
    InMsg,
    OutMsg,
    Methods,
    Handlers,
    ReflectionMethods
  >,
): ActorDefinition<
  Args,
  ExposedState,
  InMsg,
  OutMsg,
  Handlers,
  ReflectionMethods
> {
  const actorCtxMap = new Map<
    symbol,
    ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>
  >();

  function makeRuntime(
    assembly: ActorConfig<
      Args,
      InternalState,
      ExposedState,
      InMsg,
      OutMsg,
      Methods,
      Handlers,
      ReflectionMethods
    >,
  ): AsyncProcessFn<Args, ExposedState, InMsg, OutMsg> {
    return async function* (
      ctx,
      args,
    ): AsyncGenerator<ExposedState | null, void, WithSender<InMsg>> {
      let done = false;
      let exitReason: unknown;
      let stopRequested = false;
      let rawState: InternalState = undefined as unknown as InternalState;
      let exposedState: ExposedState = undefined as unknown as ExposedState;

      const decorated = new Map();

      const self = {
        ctx: ctx as ProcessCtx<Args, InternalState, InMsg, OutMsg>,
        ...((assembly.methods || {}) as Methods),
        state: rawState,
        name: ctx.pname,
        id: ctx.id,
        emit(msg: OutMsg) {
          callHook(assembly.onEmit, undefined, self, msg);
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
        $child: {} as Record<
          string,
          AsyncProcess<unknown, unknown, Message, Message>
        >,
        decorators: {},
        reflection: {},
        /* FIXME:
        decorate: (key: string, value: unknown) => {
          if (key in self) {
            throw new Error(`decorate: key "${key}" conflicts with built-in`);
          }
          if (decorated.has(key)) {
            throw new Error(`decorate: key "${key}" already decorated`);
          }
          decorated.set(key, value);
        },
        */
        fork: async <
          A,
          S,
          IM extends Message,
          OM extends Message,
          H extends HandlerOptions<IM>,
        >(
          childFn:
            AsyncProcessFn<A, S, IM, OM> | ActorDefinition<A, S, IM, OM, H>,
          name?: string,
          childArgs?: A,
        ): Promise<AsyncProcess<A, S, IM, OM>> => {
          let child: AsyncProcess<A, S, IM, OM>;
          const childDef = typeof childFn === "object" ? childFn : null;
          const childName =
            name ??
            childDef?.name ??
            `child-${Object.keys(self.$child).length}`;
          const treeName = `${ctx.pname}:${childName}`;
          if (childDef) {
            const parentPlugs = (
              assembly.plugins
                ? typeof assembly.plugins === "function"
                  ? assembly.plugins([]) // BUG: we lose track of (grand)parent plugins
                  : assembly.plugins
                : []
            ) as ActorPlugin[];
            child = await childDef.spawnAsChild(
              ctx,
              childArgs!,
              treeName,
              parentPlugs,
            );
          } else {
            const resolvedFn =
              typeof childFn === "function" ? childFn : childFn.fn;
            child = ctx.fork(resolvedFn, treeName)(childArgs!);
          }
          self.$child[child.pname] = child as unknown as AsyncProcess<
            unknown,
            unknown,
            Message,
            Message
          >;
          return child as AsyncProcess<A, S, IM, OM>;
        },
      } as ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>;
      actorCtxMap.set(ctx.id, self);

      for (const [k, v] of decorated) {
        (self as Record<string, unknown>)[k] = v;
      }

      if (assembly.setup) {
        rawState = await assembly.setup.call(self, args);
      } else if (typeof assembly.initialState === "function") {
        rawState = (assembly.initialState as any)(args, ctx);
      } else if (assembly.initialState !== undefined) {
        rawState = assembly.initialState;
      } else {
        throw new Error("ActorConfig: setup() or initialState is required");
      }
      self.state = rawState;
      exposedState = assembly.expose
        ? assembly.expose(rawState)
        : (rawState as unknown as ExposedState);
      callHook(assembly.onStart, assembly.onError, self, args);
      yield exposedState;
      callHook(assembly.afterStart, assembly.onError, self);

      yield* runDispatchAsync<WithSender<InMsg | ExitMessage>>(
        ctx.pname,
        async (stamped) => {
          const [msg, sender] = stamped;
          if (msg.type === "STOP") {
            if (assembly.onStopRequested) {
              await assembly.onStopRequested.call(self);
              if (!done) stopRequested = true;
            } else {
              exitReason = "stopped";
              done = true;
            }
            return;
          }
          if (stopRequested && !done) {
            if (assembly.onStopRequested) {
              await assembly.onStopRequested.call(self);
              if (!done) stopRequested = true;
            }
          }
          if (msg.type === "EXIT") {
            const childName = sender.fromName;
            if (childName && self.$child[childName]) {
              delete self.$child[childName];
            }
            callHook(
              assembly.onChildExit,
              assembly.onError,
              self,
              childName,
              msg as ExitMessage,
            );
          }
          if (msg.type !== "STOP" && msg.type !== "EXIT") {
            callHook(
              assembly.onMessage,
              assembly.onError,
              self,
              msg as InMsg,
              sender,
            );
          }
          if (msg.type !== "STOP") {
            const handler =
              (assembly.handlers[
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

      callHook(assembly.onEnd, assembly.onError, self, exitReason);
    };
  }

  type ReflectableProcess = {
    id: symbol;
    $reflection: Record<string, Function>;
  };
  function attachReflection(
    proc: ReflectableProcess,
    assembly: ActorConfig<
      unknown,
      unknown,
      Message,
      Message,
      Message,
      {},
      HandlerOptions<Message>
    >,
  ): void {
    const merged = new Map<string, Function>();
    if (assembly.$reflectionMethods) {
      for (const [k, m] of Object.entries(assembly.$reflectionMethods)) {
        merged.set(k, m as Function);
      }
    }

    const refl = proc.$reflection as Record<string, Function>;
    for (const [k, m] of merged) {
      refl[k] = async (...a: unknown[]) => {
        m.call(actorCtxMap.get(proc.id)!, ...a);
      };
    }
  }

  const generatorFn = makeRuntime(
    config as any as ActorConfig<
      Args,
      InternalState,
      ExposedState,
      InMsg,
      OutMsg,
      Methods,
      Handlers,
      ReflectionMethods
    >,
  ) as unknown as AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>;

  return {
    fn: generatorFn,
    name: config.name,
    pvtPluginsRaw: config.plugins,
    config: config as unknown as ActorConfig<
      Args,
      any,
      ExposedState,
      InMsg,
      OutMsg,
      {},
      Handlers
    >,
    async spawn(
      args: Args,
    ): Promise<
      AsyncProcess<Args, ExposedState, InMsg, OutMsg, ReflectionMethods>
    > {
      const plugs = resolvePlugins(config);
      const assembly = await assembleActor(config, plugs);
      const runtime = makeRuntime(assembly);
      const proc = spawnAsync(runtime, assembly.name ?? "actor")(args);
      attachReflection(proc, assembly);
      return proc;
    },
    async spawnAsChild(
      ctx: ProcessCtx<any, any, any, any>,
      args: Args,
      name?: string,
      parentPlugins?: ActorPlugin[],
    ) {
      const plugs = resolvePlugins(config, parentPlugins);
      const assembly = await assembleActor(config, plugs);
      const runtime = makeRuntime(assembly);
      const proc = ctx.fork(runtime, name ?? assembly.name ?? "child")(args);
      attachReflection(proc, assembly);
      return proc as unknown as AsyncProcess<
        Args,
        ExposedState,
        InMsg,
        OutMsg,
        ReflectionMethods
      >;
    },
  };
}
