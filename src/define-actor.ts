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
import { STOP_SENTINEL } from "./actor-types.js";
import type { ActorPlugin } from "./hooks.js";
import type { HookResult } from "./actor-types.js";

export function defineMessages<
  OutMsg extends Message = Message,
>(): ActorMessages<OutMsg> {
  return undefined as unknown as ActorMessages<OutMsg>;
}

function resolvePlugins(
  raw: ActorPlugin[] | ((parents: ActorPlugin[]) => ActorPlugin[]) | undefined,
  parentPlugins?: ActorPlugin[],
): ActorPlugin[] {
  if (!raw) return parentPlugins ? [...parentPlugins] : [];
  if (Array.isArray(raw)) return [...raw];
  return raw(parentPlugins ?? []);
}

async function assembleActor<C>(
  config: C,
  plugins: ActorPlugin[],
): Promise<C> {
  // Work with the default ActorPlugin type internally, cast back on return
  let cur: ActorConfig<unknown, unknown, Message, Message, Message, {}, HandlerOptions<Message>> = config as unknown as ActorConfig<unknown, unknown, Message, Message, Message, {}, HandlerOptions<Message>>;
  for (const p of plugins) {
    try {
      cur = await p(cur);
    } catch (e: unknown) {
      console.error(
        `[assembleActor] plugin "${(p as Function).name || "?"}" failed:`,
        e,
      );
    }
  }
  return cur as unknown as C;
}

type Hook<T, I extends unknown[], O> = (this: T, ...args: I) => O;

async function callHook<T, I extends unknown[], O>(
  fn: Hook<T, I, O> | undefined,
  eh: ((e: unknown) => unknown) | undefined,
  thisArg: T,
  ...args: I
): Promise<O | undefined> {
  if (fn) {
    try { return await fn.call(thisArg, ...args); }
    catch (e) {
      if (eh) { try { await eh(e); } catch {} }
      else { throw e; }
    }
  }
  return undefined;
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
      let rawState: InternalState = undefined as unknown as InternalState;
      let exposedState: ExposedState = undefined as unknown as ExposedState;

      const decorated = new Map();

      const self = {
        ctx: ctx as ProcessCtx<Args, InternalState, InMsg, OutMsg>,
        ...((assembly.methods || {}) as Methods),
        state: rawState,
        name: ctx.pname,
        id: ctx.id,
        async emit(msg: OutMsg) {
          await callHook(assembly.onEmit, undefined, self, msg, { fromName: ctx.pname, fromId: ctx.id });
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
                  ? assembly.plugins([])
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
        rawState = (assembly.initialState as (this: any, args: Args) => InternalState).call(self, args);
      } else if (assembly.initialState !== undefined) {
        rawState = assembly.initialState;
      } else {
        throw new Error("ActorConfig: setup() or initialState is required");
      }
      self.state = rawState;
      exposedState = assembly.expose
        ? assembly.expose(rawState)
        : (rawState as unknown as ExposedState);
      await callHook(assembly.onStart, assembly.onError, self, args);
      exposedState = assembly.expose ? assembly.expose(rawState) : (rawState as unknown as ExposedState);
      yield exposedState;
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
          if (msg.type !== "STOP" && msg.type !== "EXIT" && assembly.onMessage) {
            const result = await callHook(assembly.onMessage as any, assembly.onError, self, msg as InMsg, sender);
            if (result === STOP_SENTINEL) hookStopped = true;
          }
          if (msg.type !== "STOP" && !hookStopped) {
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

      await callHook(assembly.onEnd, assembly.onError, self, exitReason);
    };
  }

  type ReflectableProcess = {
    id: symbol;
    $reflection: Record<string, Function>;
  };
  function attachReflection(
    proc: ReflectableProcess,
    reflectionMethods: Record<string, Function> | undefined,
  ): void {
    if (!reflectionMethods) return;
    const refl = proc.$reflection as Record<string, Function>;
    for (const [k, m] of Object.entries(reflectionMethods)) {
      refl[k] = async (...a: unknown[]) => {
        return m.call(actorCtxMap.get(proc.id)!, ...a);
      };
    }
  }

  return {
    fn: makeRuntime(config),
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
      const plugs = resolvePlugins(config.plugins);
      const assembly = await assembleActor(config, plugs);
      const runtime = makeRuntime(assembly);
      const proc = spawnAsync(runtime, assembly.name ?? "actor")(args);
      attachReflection(proc, assembly.$reflectionMethods as Record<string, Function> | undefined);
      return proc as unknown as AsyncProcess<Args, ExposedState, InMsg, OutMsg, ReflectionMethods>;
    },
    async spawnAsChild(
      ctx: ProcessCtx<any, any, any, any>,
      args: Args,
      name?: string,
      parentPlugins?: ActorPlugin[],
    ) {
      const plugs = resolvePlugins(config.plugins, parentPlugins);
      const assembly = await assembleActor(config, plugs);
      const runtime = makeRuntime(assembly);
      const proc = ctx.fork(runtime, name ?? assembly.name ?? "child")(args);
      attachReflection(proc, assembly.$reflectionMethods as Record<string, Function> | undefined);
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
