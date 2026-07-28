// ── defineActor — high-level actor wrapper ───────────────────────────────────
//
// Compiles a declarative config into an AsyncProcessFn.  Built on top of
// the existing runDispatchAsync / spawnAsync primitives.
//
// See docs/proposals/define-actor-proposal.md for the full design.

import { runDispatchAsync, spawnAsync } from "./process.async.js";
import type {
  SenderInfo,
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
import { HookRegistry, stopPropagation, STOP_SENTINEL } from "./hooks.js";
import type { ActorPlugin, PluginTransform } from "./hooks.js";
import type { HookResult, OnMessageHook, OnEmitHook, OnChildExitHook, OnStartHook, OnStopRequestedHook, OnEndHook, OnErrorHook } from "./hooks.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export function defineMessages<
  OutMsg extends Message = Message,
>(): ActorMessages<OutMsg> {
  return undefined as unknown as ActorMessages<OutMsg>;
}

export function defineActor<
  Args,
  InternalState,
  ExposedState,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  Handlers extends HandlerOptions<InMsg>,
>(
  config: ActorConfig<
    Args,
    InternalState,
    ExposedState,
    InMsg,
    OutMsg,
    Methods,
    Handlers
  >,
): ActorDefinition<Args, ExposedState, InMsg, OutMsg, Handlers> {
  // Internal generator receives WithSender<InMsg> so sender identity
  // is directly accessible in the dispatch loop with zero casts.
  const fn = async function* (
    ctx: ProcessCtx<Args, ExposedState, InMsg, OutMsg>,
    args: Args,
  ): AsyncGenerator<ExposedState | null, void, WithSender<InMsg>> {
    let done = false;
    let exitReason: unknown;
    let stopRequested = false;

    // Resolve internal state — literal or function of args.
    const rawState: InternalState =
      typeof config.initialState === "function"
        ? (
            config.initialState as (
              args: Args,
              ictx: typeof ctx,
            ) => InternalState
          )(args, ctx)
        : config.initialState;

    // Apply expose if provided, otherwise identity.
    const exposedState: ExposedState = config.expose
      ? config.expose(rawState)
      : (rawState as unknown as ExposedState);

    // ── hooks ──────────────────────────────────────────────────────────
    const _hooks = new HookRegistry<any, any, any>();

    // Build the actor context.
    const self: ActorContext<
      Args,
      InternalState,
      InMsg,
      OutMsg,
      Methods,
      Handlers
    > = {
      ...((config.methods || {}) as Methods),
      state: rawState,
      name: ctx.pname,
      id: ctx.id,
      emit(msg) {
        // Fire onEmit hooks before the actual emit.
        for (const fn of _hooks.onEmit) {
          try { fn(msg); } catch (e) { /* error goes to onError */ }
        }
        ctx.toParent(msg);
      },
      agreeToStop() {
        exitReason = "stopped";
        done = true;
      },
      exit(reason) {
        exitReason = reason;
        done = true;
      },
      $child: {},
      // ── hook registration ─────────────────────────────────────
      onMessage: (fn: OnMessageHook<any>) => { _hooks.onMessage.push(fn); },
      onEmit: (fn: OnEmitHook<any>) => { _hooks.onEmit.push(fn); },
      onChildExit: (fn: OnChildExitHook) => { _hooks.onChildExit.push(fn); },
      onStopRequested: (fn: OnStopRequestedHook) => { _hooks.onStopRequested.push(fn); },
      onError: (fn: OnErrorHook) => { _hooks.onError.push(fn); },
      fork(childFn, name, childArgs) {
        // Unwrap ActorDefinition, derive name.
        const resolved = typeof childFn === "function" ? childFn : childFn.fn;
        const childDef: ActorDefinition<any,any,any,any,any> | null =
          typeof childFn === "object" ? childFn : null;
        const childName = name
          ?? (childDef?.name ? childDef.name : undefined);

        // ── plugin inheritance ───────────────────────────────────────
        // Resolve parent's installed plugins.
        const parentPlugs: ActorPlugin[] = config.plugins
          ? (typeof config.plugins === "function" ? config.plugins([]) : config.plugins)
          : [];

        // Merge with child's raw config.
        const childRaw = (childDef as any)?._pluginsRaw;
        let childPlugs: ActorPlugin[];
        if (!childRaw) {
          // No child config → inherit all parent plugins.
          childPlugs = [...parentPlugs];
        } else if (Array.isArray(childRaw)) {
          // Array → use exactly these (no inheritance).
          childPlugs = [...childRaw];
        } else {
          // Function → transform parent chain.
          childPlugs = childRaw(parentPlugs);
        }

        // Stash resolved list on the child's config before fork.
        (resolved as any).__resolvedPlugins = childPlugs;

        const child = ctx.fork(resolved, childName)(childArgs!);
        // Store under the resolved name for $child lookup and EXIT matching.
        self.$child[child.pname] = child as unknown as AsyncProcess<
          unknown,
          unknown,
          Message,
          Message
        >;
        return child;
      },
      ctx,
    };

    // ── register config.hooks (after self is built so call/this works) ─
    if (config.hooks) {
      const h = config.hooks;
      if (h.onStart)    _hooks.onStart.push((state: any) => h.onStart!.call(self, state));
      if (h.onMessage)  _hooks.onMessage.push((msg: any, sender: any) => h.onMessage!.call(self, msg, sender));
      if (h.onEmit)     _hooks.onEmit.push((msg: any) => h.onEmit!.call(self, msg));
      if (h.onChildExit) _hooks.onChildExit.push((name: string) => h.onChildExit!.call(self, name));
      if (h.onStopRequested) _hooks.onStopRequested.push(() => h.onStopRequested!.call(self));
      if (h.onEnd)      _hooks.onEnd.push((reason: unknown) => h.onEnd!.call(self, reason));
      if (h.onError)    _hooks.onError.push((err: unknown) => h.onError!.call(self, err));
    }

    // ── wire hook registration onto ctx (for plugin install) ──────
    (ctx as any).onMessage = (fn: any) => { _hooks.onMessage.push(fn); };
    (ctx as any).onEmit = (fn: any) => { _hooks.onEmit.push(fn); };
    (ctx as any).onChildExit = (fn: any) => { _hooks.onChildExit.push(fn); };
    (ctx as any).onStart = (fn: any) => { _hooks.onStart.push(fn); };
    (ctx as any).onStopRequested = (fn: any) => { _hooks.onStopRequested.push(fn); };
    (ctx as any).onError = (fn: any) => { _hooks.onError.push(fn); };

    // ── install plugins ──────────────────────────────────────────────
    // On child actors, __resolvedPlugins is set by the parent's fork().
    // On root actors, use config.plugins directly.
    const resolvedPlugs = (fn as any).__resolvedPlugins
      ?? (config.plugins
          ? (typeof config.plugins === "function" ? config.plugins([]) : config.plugins)
          : []);

    for (const p of resolvedPlugs) {
      let _err: unknown = null;
      try {
        await p.install(ctx as any);
      } catch (e) {
        _err = e;
      }
      // Also catch sync throws from non-async install functions.
      if (_err) {
        console.error(`[${ctx.pname}] plugin "${p.name}" install failed:`, _err);
      }
    }

    // Yield the exposed state — external consumers see this.
    yield exposedState;

    // Call onStart with args.
    if (config.onStart) {
      await config.onStart.call(self, args);
    }

    // Fire hooks.onStart after the actor's own onStart.
    for (const fn of _hooks.onStart) {
      try { await fn(exposedState); } catch (e) { /* error handled by onStart body */ }
    }

    // Dispatch loop..
    yield* runDispatchAsync<WithSender<InMsg | ExitMessage>>(
      ctx.pname,
      async (stamped) => {
        const [msg, sender] = stamped;

        // ── Built-in STOP handling ──────────────────────────────────
        if (msg.type === "STOP") {
          for (const fn of _hooks.onStopRequested) {
            try { await fn(); } catch {}
          }
          if (config.onStopRequested) {
            await config.onStopRequested.call(self);
            if (!done) {
              stopRequested = true;
            }
          } else {
            // Default: agree immediately.
            exitReason = "stopped";
            done = true;
          }
          return;
        }

        // ── Re-offer deferred STOP ──────────────────────────────────
        if (stopRequested && !done) {
          if (config.onStopRequested) {
            await config.onStopRequested.call(self);
            if (!done) {
              stopRequested = true;
            }
          }
        }

        // ── Built-in EXIT handling ──────────────────────────────────
        if (msg.type === "EXIT") {
          const childName = sender.fromName;

          if (childName && self.$child[childName]) {
            // Recognized child — consume EXIT here.
            delete self.$child[childName];
          }
          for (const fn of _hooks.onChildExit) {
            try { await fn(childName); } catch {}
          }
          if (config.onChildExit) {
            await config.onChildExit.call(self, childName, msg as ExitMessage);
          }
          // Unrecognized EXIT — fall through to handlers/onUnhandled.
        }

        // ── onMessage hooks ────────────────────────────────────────
        let hookStopped = false;
        if (msg.type !== "STOP" && msg.type !== "EXIT") {
          for (const fn of _hooks.onMessage) {
            try {
              const result: HookResult = await fn(msg, sender);
              if (result === STOP_SENTINEL) { hookStopped = true; break; }
            } catch (e) {
              // Error in hook: fire onError hooks, then continue.
              for (const errFn of _hooks.onError) {
                try { errFn(e); } catch {}
              }
            }
          }
        }

        // ── Named handlers ──────────────────────────────────────────
        if (msg.type !== "STOP" && !hookStopped) {
          const handler = config.handlers[
            msg.type as keyof Handlers
          ] as HandlerFn<InMsg>;
          if (handler) {
            try {
              await handler.call(self, msg as InMsg, sender);
            } catch (e) {
              for (const fn of _hooks.onError) {
                try { fn(e); } catch {}
              }
              throw e; // rethrow to trigger exit
            }
          } else if (config.onUnhandled) {
            try {
              await config.onUnhandled.call(self, msg as InMsg, sender);
            } catch (e) {
              for (const fn of _hooks.onError) {
                try { fn(e); } catch {}
              }
              throw e; // rethrow to trigger exit
            }
          }
          // No onUnhandled: silently drop.
        }

        if (done) return;
      },
      () => done,
    );

    // Fire hooks.onEnd before the actor's onEnd.
    for (const fn of _hooks.onEnd) {
      try { await fn(exitReason ?? "done"); } catch {}
    }

    // Call onEnd.
    if (config.onEnd) {
      await config.onEnd.call(self, exitReason ?? "done");
    }
  };

  return {
    fn: fn as AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>,
    name: config.name,
    _pluginsRaw: config.plugins,
    config: config as unknown as ActorConfig<
      Args,
      InternalState,
      ExposedState,
      InMsg,
      OutMsg,
      {},
      Handlers
    >,
    spawn(args: Args) {
      return spawnAsync(
        fn as AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>,
        config.name ?? "actor",
      )(args);
    },
    spawnAsChild(
      ctx: ProcessCtx<any, any, any, any>,
      name?: string,
      args: Args,
    ) {
      return ctx.fork(
        fn as AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>,
        name ?? config.name,
      )(args);
    },
  };
}
