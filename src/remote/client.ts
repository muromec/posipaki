// ── Client side of the seam ────────────────────────────────────────────────
//
// remoteClient builds a posipaki actor that talks to a remote server through a
// frame Channel produced by a spawner. It knows only the frame vocabulary
// (channel.ts) — no protocol, no transport, no spawner. The spawner has
// already done the $proto handshake.

import { defineActor } from "../define-actor.js";
import { stopPropagation } from "../hooks.js";
import type { HookResult } from "../hooks.js";
import type { ActorDefinition, HandlerOptions, MethodOptions, ReflectionOptions } from "../actor-types.js";
import type { Message } from "../types.js";
import type { Channel } from "./channel.js";
import { ProcessHandles, decodeProcessRefs, encodeProcessRefs } from "./process-ref.js";
import {
  REFLECT_CALL,
  asReflectionResult,
  isExit,
  isMsg,
  isReflectionMethods,
  isState,
  jsonProblem,
} from "./channel.js";

export type ClientSpawner<Args> = (args: Args) => Promise<Channel>;


export function remoteClient<
  Args,
  State,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions = MethodOptions,
  Handlers extends HandlerOptions<InMsg> = HandlerOptions<InMsg>,
  R extends ReflectionOptions = ReflectionOptions,
>(
  name: string,
  spawner: ClientSpawner<Args>,
): ActorDefinition<Args, State, InMsg, OutMsg, R> {
  const proxyDef = defineActor<
    Args,
    { public: State; private: { channel: Channel; exitPromise: Promise<{ code: number | null; state: State }>; fromName: string } },
    InMsg,
    OutMsg,
    Methods,
    Handlers,
    R
  >({
    name,
    handlers: {} as unknown as Handlers,
    async setup(args: Args) {
      const channel = await spawner(args);
      const fromName = name;
      await channel.send({
        $init: { ...(args as unknown as Record<string, unknown>), parentName: fromName, parentIdName: fromName },
      });

      let currentState: Record<string, unknown> = {};

      // ── the call side ──────────────────────────────────────────────────
      // Every reflection method the far side announced becomes one function on
      // this process's reflection surface.  `seq` belongs to this connection
      // and is never reused, so two calls to the same method in flight at once
      // stay apart; the answer names the one it belongs to.
      // The ids this side hands out, for the processes it sends the other way;
      // the far side has a table of its own and neither one means anything on
      // the other connection.
      const handles = new ProcessHandles();
      let calls = 0;
      const pending = new Map<
        number,
        { name: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
      >();

      const install = (methods: string[]): void => {
        const surface = this.reflection as unknown as Record<string, unknown>;
        for (const method of methods) {
          surface[method] = (...callArgs: unknown[]) =>
            new Promise((resolve, reject) => {
              // Processes among the arguments become references first — mine,
              // with ids from my table, or the far side's own coming back — and
              // what is left has to be JSON, or nothing is sent at all.
              const wireArgs = encodeProcessRefs(callArgs, handles);
              const problem = jsonProblem(wireArgs);
              if (problem !== null) {
                reject(new Error(`cannot send ${problem} to ${method}`));
                return;
              }
              const seq = ++calls;
              pending.set(seq, { name: method, resolve, reject });
              void Promise.resolve(
                channel.send({ [`${REFLECT_CALL}${method}`]: { seq, args: wireArgs } }),
              ).catch((error: unknown) => {
                pending.delete(seq);
                reject(error instanceof Error ? error : new Error(String(error)));
              });
            });
        }
      };

      // The announcement comes before the first $state, so both are gathered
      // here; a peer that says it later is still honoured, by the handler below.
      await new Promise<void>((resolve) => {
        channel.onMessage((frame) => {
          if (isReflectionMethods(frame)) {
            install(frame["$r.methods"]);
            return;
          }
          if (isState(frame)) {
            Object.assign(currentState, frame.$state);
            resolve();
          }
        });
      });
      channel.removeHandler();

      let exitResolver: ((v: { code: number | null; state: State }) => void) | null = null;
      const exitPromise = new Promise<{ code: number | null; state: State }>((resolve) => {
        exitResolver = resolve;
      });

      channel.onMessage((frame) => {
        if (isState(frame)) {
          Object.assign(currentState, frame.$state);
          // $state frames arrive outside this actor's dispatch loop; notify
          // state subscribers so observers (Vue, nextState, …) see the change.
          this.ctx.notify();
        } else if (isMsg(frame)) {
          this.emit(frame.$msg.body as OutMsg);
        } else if (isExit(frame)) {
          if (exitResolver) {
            exitResolver({ code: frame.$exit.code, state: frame.$exit.state as State });
            exitResolver = null;
          }
        } else if (isReflectionMethods(frame)) {
          install(frame["$r.methods"]);
        } else {
          const result = asReflectionResult(frame);
          if (!result) return;
          const waiting = pending.get(result.seq);
          if (!waiting) return;
          pending.delete(result.seq);
          if (result.error === undefined) waiting.resolve(decodeProcessRefs(result.value));
          else waiting.reject(new Error(`${waiting.name}: ${result.error}`));
        }
      });
      channel.onClose(() => {
        // A call that was in flight when the wire went away has no answer
        // coming; it fails here rather than hanging forever.
        for (const waiting of pending.values()) {
          waiting.reject(new Error(`connection closed before ${waiting.name} answered`));
        }
        pending.clear();
        if (exitResolver) {
          exitResolver({ code: null, state: currentState as State });
          exitResolver = null;
        }
      });

      return {
        public: currentState as State,
        private: { channel, exitPromise, fromName },
      };

    },
    async onMessage(msg: InMsg): Promise<HookResult> {
      this.state.private.channel?.send({ $msg: { fromName: this.state.private.fromName, body: msg } });
      return stopPropagation();
    },
    async onStopRequested() {
      if (this.state.private.channel) {
        this.state.private.channel.send({ $msg: { fromName: this.state.private.fromName, body: { type: "STOP" } } });
        await this.state.private.exitPromise;
      }
      this.agreeToStop();
    },
    async afterEnd() {
      if (this.state.private.channel) {
        await this.state.private.channel.close();
      }
    },
  });

  return proxyDef as unknown as ActorDefinition<Args, State, InMsg, OutMsg, R>;
}
