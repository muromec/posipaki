// ── defineActor — high-level actor wrapper ───────────────────────────────────
//
// Compiles a declarative config into an AsyncProcessFn.  Built on top of
// the existing runDispatchAsync / spawnAsync primitives.
//
// See docs/proposals/define-actor-proposal.md for the full design.

import { runDispatchAsync } from "./process.async.js";
import type { AsyncProcessFn, Message, ProcessCtx, ProcessFn } from "./types.js";
import type { AsyncProcess } from "./process.async.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface ActorDefinition<Args, ExposedState, InMsg extends Message, OutMsg extends Message> {
  fn: AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>;
  config: ActorConfig<Args, any, ExposedState, InMsg, OutMsg>;
}

export interface ActorConfig<
  Args,
  InternalState,
  ExposedState,
  InMsg extends Message,
  OutMsg extends Message,
> {
  initialState: InternalState | ((args: Args) => InternalState);
  expose?: (internalState: InternalState) => ExposedState;

  onStart?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    args: Args,
  ) => void | Promise<void>;

  onStopRequested?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
  ) => void | Promise<void>;

  onEnd?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    reason?: unknown,
  ) => void | Promise<void>;

  handlers: {
    [K in InMsg["type"]]?: (
      this: ActorContext<Args, InternalState, InMsg, OutMsg>,
      msg: Extract<InMsg, { type: K }>,
    ) => void | Promise<void>;
  };

  onUnhandled?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    msg: InMsg,
  ) => void | Promise<void>;

  onChildExit?: (
    this: ActorContext<Args, InternalState, InMsg, OutMsg>,
    name: string,
    reason: { type: "EXIT"; pid: symbol; fromName?: string; fromId?: symbol },
  ) => void | Promise<void>;
}

export interface ActorContext<
  Args,
  InternalState,
  InMsg extends Message,
  OutMsg extends Message,
> {
  state: InternalState;
  name: string;
  id: symbol;

  emit: (msg: OutMsg) => void;
  agreeToStop: () => void;
  exit: (reason?: unknown) => void;

  $child: Record<string, AsyncProcess<unknown, unknown, Message, Message>>;

  fork<A, S, IM extends Message, OM extends Message>(
    fn: AsyncProcessFn<A, S, IM, OM> | ProcessFn<A, S, IM, OM> | ActorDefinition<A, S, IM, OM>,
    name: string,
    args?: A,
  ): AsyncProcess<A, S, IM, OM>;

  ctx: ProcessCtx<Args, InternalState, InMsg, OutMsg>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export function defineActor<
  Args,
  InternalState,
  ExposedState = InternalState,
  InMsg extends Message = Message,
  OutMsg extends Message = Message,
>(
  config: ActorConfig<Args, InternalState, ExposedState, InMsg, OutMsg>,
): ActorDefinition<Args, ExposedState, InMsg, OutMsg> {

  const fn: AsyncProcessFn<Args, ExposedState, InMsg, OutMsg> =
    async function* (ctx, args) {
      let done = false;
      let exitReason: unknown;
      let stopRequested = false;

      // Resolve internal state — literal or function of args.
      const rawState: InternalState = typeof config.initialState === "function"
        ? (config.initialState as (args: Args) => InternalState)(args)
        : config.initialState;

      // Apply expose if provided, otherwise identity.
      const exposedState: ExposedState = config.expose
        ? config.expose(rawState)
        : rawState as unknown as ExposedState;

      // The process's Symbol id is constructed from its name in both
      // Process and AsyncProcess constructors.  ctx doesn't carry `id`,

      // Build the actor context.
      const self: ActorContext<Args, InternalState, InMsg, OutMsg> = {
        state: rawState,
        name: ctx.pname,
        id: ctx.id,
        emit(msg) {
          ctx.toParent({
            ...msg,
            fromName: ctx.pname,
            fromId: ctx.id,
          } as OutMsg);
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
        fork(childFn, name, childArgs) {
          // Unwrap ActorDefinition, pass to ctx.fork.
          // asyncify handles both sync ProcessFn and async generators
          // at runtime; the cast bridges the type gap.
          const resolved = typeof childFn === "function" ? childFn : childFn.fn;
          const child = ctx.fork(resolved as AsyncProcessFn<any, any, any, any>, name)(childArgs);
          self.$child[name] = child;
          return child;
        },
        ctx,
      };

      // Yield the exposed state — external consumers see this.
      yield exposedState;

      // Call onStart with args.
      if (config.onStart) {
        await config.onStart.call(self, args);
      }

      // Dispatch loop.
      yield* runDispatchAsync(
        ctx.pname,
        async (msg: InMsg) => {
          // ── Built-in STOP handling ──────────────────────────────────
          if (msg.type === "STOP") {
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
            const exitMsg = msg as unknown as {
              type: "EXIT"; pid: symbol; fromName?: string; fromId?: symbol;
            };
            const childName = exitMsg.fromName;

            if (childName && self.$child[childName]) {
              // Recognized child — consume EXIT here.
              delete self.$child[childName];
              if (config.onChildExit) {
                await config.onChildExit.call(self, childName, exitMsg);
              }
              return;
            }
            // Unrecognized EXIT — fall through to handlers/onUnhandled.
          }

          // ── Named handlers ──────────────────────────────────────────
          if (msg.type !== "STOP") {
            const handler = (config.handlers as Record<string, ((msg: InMsg) => void | Promise<void>) | undefined>)[msg.type];
            if (handler) {
              await handler.call(self, msg);
            } else if (config.onUnhandled) {
              await config.onUnhandled.call(self, msg);
            }
            // No onUnhandled: silently drop.
          }

          if (done) return;
        },
        () => done,
      );

      // Call onEnd.
      if (config.onEnd) {
        await config.onEnd.call(self, exitReason ?? "done");
      }
    };

  return {
    fn,
    config,
  };
}
