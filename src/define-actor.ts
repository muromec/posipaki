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
import type { HookResult } from "./hooks.js";

export function defineMessages<OutMsg extends Message = Message>(): ActorMessages<OutMsg> {
  return undefined as unknown as ActorMessages<OutMsg>;
}

function resolvePlugins(
  config: ActorConfig<any, any, any, any, any, any, any>,
  parentPlugins?: ActorPlugin[],
): ActorPlugin[] {
  const raw = config.plugins;
  if (!raw) return parentPlugins ? [...parentPlugins] : [];
  if (Array.isArray(raw)) return [...raw];
  return raw(parentPlugins ?? []);
}

async function assembleActor(
  config: ActorConfig<any, any, any, any, any, any, any>,
  plugins: ActorPlugin[],
): Promise<ActorConfig<any, any, any, any, any, any, any>> {
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
        ctx: ctx as any, ...((assembly.methods || {}) as Methods),
        state: rawState, name: ctx.pname, id: ctx.id,
        emit(msg: any) { for (const h of ph.onEmit) { try { h(msg) } catch {} } ctx.toParent(msg); },
        agreeToStop() { exitReason = "stopped"; done = true; },
        exit(reason: unknown) { exitReason = reason; done = true; },
        $child: {},
        hooks: {
          onMessage: (h: any) => ph.onMessage.push(h), onEmit: (h: any) => ph.onEmit.push(h),
          onChildExit: (h: any) => ph.onChildExit.push(h), onStart: (h: any) => ph.onStart.push(h),
          onStopRequested: (h: any) => ph.onStopRequested.push(h), onError: (h: any) => ph.onError.push(h),
          onEnd: (h: any) => ph.onEnd.push(h),
        },
        reflection: { register(name: string, method: any) { (assembly.pluginReflection ?? new Map()).set(`runtime.${name}`, method); } },
        decorate: (key: string, value: unknown) => {
          if (key in self) throw new Error(`decorate: key "${key}" conflicts with built-in`);
          if (decorated.has(key)) throw new Error(`decorate: key "${key}" already decorated`);
          decorated.set(key, value);
        },
        async fork(childFn: any, name: any, childArgs: any) {
          const childDef = typeof childFn === "object" ? childFn : null;
          const childName = name ?? childDef?.name ?? `child-${Object.keys(self.$child).length}`;
          const treeName = `${ctx.pname}:${childName}`;
          let child: AsyncProcess<unknown, unknown, Message, Message>;
          if (childDef) {
            const parentPlugs = (assembly.plugins
              ? (typeof assembly.plugins === "function" ? assembly.plugins([]) : assembly.plugins)
              : []) as ActorPlugin[];
            child = await childDef.spawnAsChild(ctx, childArgs!, treeName, parentPlugs) as any;
          } else {
            const resolvedFn = typeof childFn === "function" ? childFn : childFn.fn;
            child = ctx.fork(resolvedFn, treeName)(childArgs!) as any;
          }
          (self.$child as any)[child.pname] = child;
          return child;
        },
      };
      actorCtxMap.set(ctx.id, self as any);

      if (assembly.hooks) {
        const h = assembly.hooks;
        if (h.onStart) ph.onStart.push((s: unknown) => (h.onStart as any)!.call(self as any, s));
        if (h.onMessage) ph.onMessage.push((m: any, s: any) => h.onMessage!.call(self as any, m, s));
        if (h.onEmit) ph.onEmit.push((m: any) => h.onEmit!.call(self as any, m));
        if (h.onChildExit) ph.onChildExit.push((n: string) => h.onChildExit!.call(self as any, n));
        if (h.onStopRequested) ph.onStopRequested.push(() => h.onStopRequested!.call(self as any));
        if (h.onEnd) ph.onEnd.push((r: unknown) => h.onEnd!.call(self as any, r));
        if (h.onError) ph.onError.push((e: unknown) => h.onError!.call(self as any, e));
      }
      for (const [k, v] of decorated) { (self as any)[k] = v; }

      if (assembly.setup) { rawState = await assembly.setup.call(self as any, args); }
      else if (typeof assembly.initialState === "function") { rawState = (assembly.initialState as any)(args, ctx); }
      else if (assembly.initialState !== undefined) { rawState = assembly.initialState; }
      else { throw new Error("ActorConfig: setup() or initialState is required"); }
      (self as any).state = rawState;
      exposedState = assembly.expose ? assembly.expose(rawState) : (rawState as any);
      if (assembly.onStart) { await assembly.onStart.call(self as any, args);
        exposedState = assembly.expose ? assembly.expose(rawState) : (rawState as any); }
      for (const h of ph.onStart) { try { await h(exposedState) } catch {} }
      yield exposedState;
      if (assembly.afterStart) { await assembly.afterStart.call(self as any); }

      yield* runDispatchAsync<WithSender<InMsg | ExitMessage>>(ctx.pname, async (stamped) => {
        const [msg, sender] = stamped;
        if (msg.type === "STOP") {
          for (const h of ph.onStopRequested) { try { await h() } catch {} }
          if (assembly.onStopRequested) { await assembly.onStopRequested.call(self as any); if (!done) stopRequested = true; }
          else { exitReason = "stopped"; done = true; }
          return;
        }
        if (stopRequested && !done) {
          if (assembly.onStopRequested) { await assembly.onStopRequested.call(self as any); if (!done) stopRequested = true; }
        }
        if (msg.type === "EXIT") {
          const childName = sender.fromName;
          if (childName && (self.$child as any)[childName]) delete (self.$child as any)[childName];
          for (const h of ph.onChildExit) { try { await h(childName) } catch {} }
          if (assembly.onChildExit) await assembly.onChildExit.call(self as any, childName, msg as ExitMessage);
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
            try { await handler.call(self as any, msg as InMsg, sender); }
            catch (e) { for (const eh of ph.onError) { try { eh(e) } catch {} } throw e; }
          } else if (assembly.onUnhandled) {
            try { await assembly.onUnhandled.call(self as any, msg as InMsg, sender); }
            catch (e) { for (const eh of ph.onError) { try { eh(e) } catch {} } throw e; }
          }
        }
      }, () => done);

      for (const h of ph.onEnd) { try { await h(exitReason) } catch {} }
      if (assembly.onEnd) await assembly.onEnd.call(self as any, exitReason);
    };
  }

  type ReflectableProcess = { id: symbol; $reflection: Record<string, Function> };
  function attachReflection(proc: ReflectableProcess, assembly: ActorConfig<any, any, any, any, any, any, any>): void {
    const merged = new Map<string, Function>();
    if (assembly.$reflectionMethods) for (const [k, m] of Object.entries(assembly.$reflectionMethods)) merged.set(k, m as Function);
    if (assembly.pluginReflection) for (const [k, m] of assembly.pluginReflection) merged.set(k, m);
    const refl = proc.$reflection as Record<string, Function>;
    for (const [k, m] of merged) refl[k] = async (...a: unknown[]) => m.call(actorCtxMap.get(proc.id)!, ...a);
  }

  const legacyFn = makeRuntime(config as any) as unknown as AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>;

  return {
    fn: legacyFn, name: config.name, pvtPluginsRaw: config.plugins,
    config: config as any,
    async spawn(args: Args) {
      const plugs = resolvePlugins(config);
      const assembly = await assembleActor(config, plugs);
      const runtime = makeRuntime(assembly as any);
      const proc = spawnAsync(runtime, assembly.name ?? "actor")(args);
      attachReflection(proc, assembly);
      return proc as any;
    },
    async spawnAsChild(ctx: ProcessCtx<any, any, any, any>, args: Args, name?: string, parentPlugins?: ActorPlugin[]) {
      const plugs = resolvePlugins(config, parentPlugins);
      const assembly = await assembleActor(config, plugs);
      const runtime = makeRuntime(assembly as any);
      const proc = ctx.fork(runtime, name ?? assembly.name ?? "child")(args);
      attachReflection(proc, assembly);
      return proc as any;
    },
  };
}
