// ── defineActor — high-level actor wrapper ───────────────────────────────────
//
// Compiles a declarative config into an AsyncProcessFn.  Built on top of
// the existing runDispatchAsync / spawnAsync primitives.
//
// See docs/proposals/define-actor-proposal.md for the full design.

import { runDispatchAsync } from "./process.async.js";
import type { AsyncProcessFn, Message, ExitMessage } from "./types.js";
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
  const fn: AsyncProcessFn<Args, ExposedState, InMsg, OutMsg> =
    async function* (ctx, args) {
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
          const resolved = typeof childFn === "function" ? childFn : childFn.fn;
          const child = ctx.fork(resolved, name)(childArgs!);
          self.$child[name] = child as unknown as AsyncProcess<
            unknown,
            unknown,
            Message,
            Message
          >;
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
            const exitMsg = msg as unknown as ExitMessage;
            const childName = exitMsg.fromName;

            if (childName && self.$child[childName]) {
              // Recognized child — consume EXIT here.
              delete self.$child[childName];
            }
            if (config.onChildExit) {
              await config.onChildExit.call(self, childName, exitMsg);
            }
            // Unrecognized EXIT — fall through to handlers/onUnhandled.
          }

          // ── Named handlers ──────────────────────────────────────────
          if (msg.type !== "STOP") {
            const handler = config.handlers[
              msg.type as keyof Handlers
            ] as HandlerFn<InMsg>;
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
    config: config as unknown as ActorConfig<
      Args,
      InternalState,
      ExposedState,
      InMsg,
      OutMsg,
      {},
      Handlers
    >,
  };
}
