// ── defineActor — high-level actor wrapper ───────────────────────────────────
//
// Compiles a declarative config into an AsyncProcessFn.  Built on top of
// the existing runDispatchAsync / spawnAsync primitives.
//
// Phase 2: assembly outside the generator, async spawn.

import { runDispatchAsync, spawnAsync } from "./process.async.js";
import type { WithSender, AsyncProcessFn, Message, ExitMessage, ProcessCtx } from "./types.js";
import type { AsyncProcess } from "./process.async.js";
import type {
  ActorDefinition, ActorConfig, ActorContext, MethodOptions, ActorMessages, HandlerOptions, HandlerFn,
} from "./actor-types.js";
import { STOP_SENTINEL } from "./hooks.js";
import type { ActorPlugin } from "./hooks.js";
import type { HookResult, OnMessageHook, OnEmitHook, OnChildExitHook, OnStartHook, OnStopRequestedHook, OnEndHook, OnErrorHook } from "./hooks.js";

export function defineMessages<OutMsg extends Message = Message>(): ActorMessages<OutMsg> {
  return undefined as unknown as ActorMessages<OutMsg>;
}

function resolvePlugins(
  config: ActorConfig<unknown, unknown, Message, Message, Message, {}, HandlerOptions<Message>>,
  parentPlugins?: ActorPlugin[],
): ActorPlugin[] {
  const raw = config.plugins;
  if (!raw) return parentPlugins ? [...parentPlugins] : [];
  if (Array.isArray(raw)) return [...raw];
  return raw(parentPlugins ?? []);
}

async function assembleActor(
  config: ActorConfig<unknown, unknown, Message, Message, Message, {}, HandlerOptions<Message>>,
  plugins: ActorPlugin[],
): Promise<ActorConfig<unknown, unknown, Message, Message, Message, {}, HandlerOptions<Message>>> {
  if (!config.pluginHooks) config.pluginHooks = { onMessage:[],onEmit:[],onChildExit:[],onStart:[],onStopRequested:[],onError:[],onEnd:[] };
  if (!config.pluginReflection) config.pluginReflection = new Map();
  if (!config.pluginDecorators) config.pluginDecorators = new Map();

  for (const p of plugins) {
    try {
      config = await p(config);
    } catch (e: unknown) {
      console.error(`[assembleActor] plugin "${(p as Function).name || '?'}" failed:`, e);
    }
  }
  return config;
}

export function defineActor<
  Args, InternalState, ExposedState, InMsg extends Message, OutMsg extends Message,
  Methods extends MethodOptions, Handlers extends HandlerOptions<InMsg>, ReflectionMethods = {},
>(
  config: ActorConfig<Args, InternalState, ExposedState, InMsg, OutMsg, Methods, Handlers, ReflectionMethods>,
): ActorDefinition<Args, ExposedState, InMsg, OutMsg, Handlers, ReflectionMethods> {

  const actorCtxMap = new Map<symbol, ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>>();

  function makeRuntime(
    assembly: ActorConfig<Args, InternalState, ExposedState, InMsg, OutMsg, Methods, Handlers, ReflectionMethods>,
  ): AsyncProcessFn<Args, ExposedState, InMsg, OutMsg> {
    return async function* (ctx, args): AsyncGenerator<ExposedState | null, void, WithSender<InMsg>> {
      let done = false; let exitReason: unknown; let stopRequested = false;
      let rawState: InternalState = undefined as unknown as InternalState;
      let exposedState: ExposedState = undefined as unknown as ExposedState;

      const ph = assembly.pluginHooks ?? { onMessage:[],onEmit:[],onChildExit:[],onStart:[],onStopRequested:[],onError:[],onEnd:[] };
      const pd = assembly.pluginDecorators ?? new Map();
      const decorated = new Map(pd);

      const self = {
        ctx: ctx as ProcessCtx<Args, InternalState, InMsg, OutMsg>,
        ...((assembly.methods || {}) as Methods),
        state: rawState, name: ctx.pname, id: ctx.id,
        emit(msg: OutMsg) { for (const h of ph.onEmit) { try { h(msg) } catch {} } ctx.toParent(msg); },
        agreeToStop() { exitReason = "stopped"; done = true; },
        exit(reason: unknown) { exitReason = reason; done = true; },
        $child: {} as Record<string, AsyncProcess<unknown, unknown, Message, Message>>,
        hooks: {
          onMessage: (h: OnMessageHook<InMsg>) => ph.onMessage.push(h),
          onEmit: (h: OnEmitHook<OutMsg>) => ph.onEmit.push(h),
          onChildExit: (h: OnChildExitHook) => ph.onChildExit.push(h),
          onStart: (h: OnStartHook<ExposedState>) => ph.onStart.push(h),
          onStopRequested: (h: OnStopRequestedHook) => ph.onStopRequested.push(h),
          onError: (h: OnErrorHook) => ph.onError.push(h),
          onEnd: (h: OnEndHook) => ph.onEnd.push(h),
        },
        reflection: { register(name: string, method: Function) { (assembly.pluginReflection ?? new Map()).set(`runtime.${name}`, method); } },
        decorate: (key: string, value: unknown) => {
          if (key in self) throw new Error(`decorate: key "${key}" conflicts with built-in`);
          if (decorated.has(key)) throw new Error(`decorate: key "${key}" already decorated`);
          decorated.set(key, value);
        },
        fork: async <A, S, IM extends Message, OM extends Message, H extends HandlerOptions<IM>>(
          childFn: AsyncProcessFn<A, S, IM, OM> | ActorDefinition<A, S, IM, OM, H>,
          name?: string,
          childArgs?: A,
        ): Promise<AsyncProcess<A, S, IM, OM>> => {
          const childDef = typeof childFn === "object" ? childFn : null;
          const childName = name ?? childDef?.name ?? `child-${Object.keys(self.$child).length}`;
          const treeName = `${ctx.pname}:${childName}`;
          if (childDef) {
            const parentPlugs = (assembly.plugins
              ? (typeof assembly.plugins === "function" ? assembly.plugins([]) : assembly.plugins)
              : []) as ActorPlugin[];
            const child = await childDef.spawnAsChild(ctx, childArgs!, treeName, parentPlugs);
            self.$child[child.pname] = child as unknown as AsyncProcess<unknown, unknown, Message, Message>;
            return child as unknown as AsyncProcess<A, S, IM, OM>;
          }
          const resolvedFn = typeof childFn === "function" ? childFn : childFn.fn;
          const child = ctx.fork(resolvedFn, treeName)(childArgs!);
          self.$child[child.pname] = child as unknown as AsyncProcess<unknown, unknown, Message, Message>;
          return child as unknown as AsyncProcess<A, S, IM, OM>;
        },
      } as ActorContext<Args, InternalState, InMsg, OutMsg, Methods, Handlers>;
      actorCtxMap.set(ctx.id, self);

      if (assembly.hooks) {
        const h = assembly.hooks;
        if (h.onStart) ph.onStart.push((s: ExposedState) => h.onStart!.call(self, s));
        if (h.onMessage) ph.onMessage.push((m: any, s: any) => h.onMessage!.call(self, m, s));
        if (h.onEmit) ph.onEmit.push((m: any) => h.onEmit!.call(self, m));
        if (h.onChildExit) ph.onChildExit.push((n: string) => h.onChildExit!.call(self, n));
        if (h.onStopRequested) ph.onStopRequested.push(() => h.onStopRequested!.call(self));
        if (h.onEnd) ph.onEnd.push((r: unknown) => h.onEnd!.call(self, r));
        if (h.onError) ph.onError.push((e: unknown) => h.onError!.call(self, e));
      }
      for (const [k, v] of decorated) { (self as Record<string, unknown>)[k] = v; }

      if (assembly.setup) { rawState = await assembly.setup.call(self, args); }
      else if (typeof assembly.initialState === "function") { rawState = (assembly.initialState as any)(args, ctx); }
      else if (assembly.initialState !== undefined) { rawState = assembly.initialState; }
      else { throw new Error("ActorConfig: setup() or initialState is required"); }
      self.state = rawState;
      exposedState = assembly.expose ? assembly.expose(rawState) : (rawState as unknown as ExposedState);
      if (assembly.onStart) { await assembly.onStart.call(self, args);
        exposedState = assembly.expose ? assembly.expose(rawState) : (rawState as unknown as ExposedState); }
      for (const h of ph.onStart) { try { await h(exposedState) } catch {} }
      yield exposedState;
      if (assembly.afterStart) { await assembly.afterStart.call(self); }

      yield* runDispatchAsync<WithSender<InMsg | ExitMessage>>(ctx.pname, async (stamped) => {
        const [msg, sender] = stamped;
        if (msg.type === "STOP") {
          for (const h of ph.onStopRequested) { try { await h() } catch {} }
          if (assembly.onStopRequested) { await assembly.onStopRequested.call(self); if (!done) stopRequested = true; }
          else { exitReason = "stopped"; done = true; }
          return;
        }
        if (stopRequested && !done) {
          if (assembly.onStopRequested) { await assembly.onStopRequested.call(self); if (!done) stopRequested = true; }
        }
        if (msg.type === "EXIT") {
          const childName = sender.fromName;
          if (childName && self.$child[childName]) delete self.$child[childName];
          for (const h of ph.onChildExit) { try { await h(childName) } catch {} }
          if (assembly.onChildExit) await assembly.onChildExit.call(self, childName, msg as ExitMessage);
        }
        let hookStopped = false;
        if (msg.type !== "STOP" && msg.type !== "EXIT") {
          for (const h of ph.onMessage) {
            try { const r: HookResult = await h(msg, sender); if (r === STOP_SENTINEL) { hookStopped = true; break; } }
            catch (e) { for (const eh of ph.onError) { try { eh(e) } catch {} } }
          }
        }
        if (msg.type !== "STOP" && !hookStopped) {
          const handler = assembly.handlers[msg.type as keyof Handlers] as HandlerFn<InMsg>;
          if (handler) {
            try { await handler.call(self, msg as InMsg, sender); }
            catch (e) { for (const eh of ph.onError) { try { eh(e) } catch {} } throw e; }
          } else if (assembly.onUnhandled) {
            try { await assembly.onUnhandled.call(self, msg as InMsg, sender); }
            catch (e) { for (const eh of ph.onError) { try { eh(e) } catch {} } throw e; }
          }
        }
      }, () => done);

      for (const h of ph.onEnd) { try { await h(exitReason) } catch {} }
      if (assembly.onEnd) await assembly.onEnd.call(self, exitReason);
    };
  }

  type ReflectableProcess = { id: symbol; $reflection: Record<string, Function> };
  function attachReflection(proc: ReflectableProcess, assembly: ActorConfig<unknown, unknown, Message, Message, Message, {}, HandlerOptions<Message>>): void {
    const merged = new Map<string, Function>();
    if (assembly.$reflectionMethods) for (const [k, m] of Object.entries(assembly.$reflectionMethods)) merged.set(k, m as Function);
    if (assembly.pluginReflection) for (const [k, m] of assembly.pluginReflection) merged.set(k, m);
    const refl = proc.$reflection as Record<string, Function>;
    for (const [k, m] of merged) refl[k] = async (...a: unknown[]) => m.call(actorCtxMap.get(proc.id)!, ...a);
  }

  const legacyFn = makeRuntime(config as any as ActorConfig<Args, InternalState, ExposedState, InMsg, OutMsg, Methods, Handlers, ReflectionMethods>) as unknown as AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>;

  return {
    fn: legacyFn, name: config.name, pvtPluginsRaw: config.plugins,
    config: config as unknown as ActorConfig<Args, any, ExposedState, InMsg, OutMsg, {}, Handlers>,
    async spawn(args: Args) {
      const cfg = config as unknown as ActorConfig<unknown, unknown, Message, Message, Message, {}, HandlerOptions<Message>>;
      const plugs = resolvePlugins(cfg);
      const assembly = await assembleActor(cfg, plugs);
      const runtime = makeRuntime(assembly as any as ActorConfig<Args, InternalState, ExposedState, InMsg, OutMsg, Methods, Handlers, ReflectionMethods>);
      const proc = spawnAsync(runtime, assembly.name ?? "actor")(args);
      attachReflection(proc, assembly);
      return proc as unknown as AsyncProcess<Args, ExposedState, InMsg, OutMsg, ReflectionMethods>;
    },
    async spawnAsChild(ctx: ProcessCtx<any, any, any, any>, args: Args, name?: string, parentPlugins?: ActorPlugin[]) {
      const cfg = config as unknown as ActorConfig<unknown, unknown, Message, Message, Message, {}, HandlerOptions<Message>>;
      const plugs = resolvePlugins(cfg, parentPlugins);
      const assembly = await assembleActor(cfg, plugs);
      const runtime = makeRuntime(assembly as any as ActorConfig<Args, InternalState, ExposedState, InMsg, OutMsg, Methods, Handlers, ReflectionMethods>);
      const proc = ctx.fork(runtime, name ?? assembly.name ?? "child")(args);
      attachReflection(proc, assembly);
      return proc as unknown as AsyncProcess<Args, ExposedState, InMsg, OutMsg, ReflectionMethods>;
    },
  };
}
