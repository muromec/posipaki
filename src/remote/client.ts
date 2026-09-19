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
import { ProcessTable, ROOT_ID } from "./process-ref.js";
import {
  REFLECT_CALL,
  asReflectionResult,
  decodeFrame,
  encodeFrame,
  frameTo,
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
    {
      public: State;
      private: {
        channel: Channel;
        table: ProcessTable;
        exitPromise: Promise<{ code: number | null; state: State }>;
        fromName: string;
      };
    },
    InMsg,
    OutMsg,
    Methods,
    Handlers,
    R
  >({
    name,
    handlers: {} as unknown as Handlers,
    async setup(args: Args) {
      // This side's own end of the connection is the root, and id 0 is how both
      // sides name it: the far actor on one end, this proxy on the other.  So
      // the table starts with the root bound and nothing else in it.
      const table = new ProcessTable();
      const root = this.ctx;
      table.bindRoot(root);
      const channel = await spawner(args);
      const fromName = name;
      await channel.send(
        encodeFrame(
          {
            $init: {
              ...(args as unknown as Record<string, unknown>),
              parentName: fromName,
              parentIdName: fromName,
            },
          },
          table,
        ),
      );

      let currentState: Record<string, unknown> = {};

      // ── the call side ──────────────────────────────────────────────────
      // Every reflection method the far side announced becomes one function on
      // this process's reflection surface.  `seq` belongs to this connection
      // and is never reused, so two calls to the same method in flight at once
      // stay apart; the answer names the one it belongs to.
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
              const seq = ++calls;
              const frame = encodeFrame(
                { [`${REFLECT_CALL}${method}`]: { seq, args: callArgs } },
                table,
              );
              const problem = jsonProblem(frame);
              if (problem !== null) {
                reject(new Error(`cannot send ${problem} to ${method}`));
                return;
              }
              pending.set(seq, { name: method, resolve, reject });
              void Promise.resolve(channel.send(frame)).catch((error: unknown) => {
                pending.delete(seq);
                reject(error instanceof Error ? error : new Error(String(error)));
              });
            });
        }
      };

      // The announcement comes before the first $state, so both are gathered
      // here; a peer that says it later is still honoured, by the handler below.
      await new Promise<void>((resolve) => {
        channel.onMessage((raw) => {
          const frame = decodeFrame(raw);
          if (frameTo(frame) !== ROOT_ID) return;
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

      channel.onMessage((raw) => {
        const frame = decodeFrame(raw);
        // Every frame is looked up once, by the process it addresses — the root
        // when it addresses none — so which frames a connection accepts is the
        // table's answer, not a rule per frame kind.
        const to = frameTo(frame);
        const target = to === null ? undefined : table.processFor(to);
        // An id this connection does not hold: there is nothing to deliver to.
        // (A side that hands out an id it then drops is worth telling, which is
        // what a release will be.)
        if (!target) return;
        if (target !== root) {
          // A process this side holds a handle on: what it does with its own
          // frames is the handle's business, and there is no handle yet.
          return;
        }
        if (isState(frame)) {
          Object.assign(currentState, frame.$state);
          // $state frames arrive outside this actor's dispatch loop; notify
          // state subscribers so observers (Vue, nextState, …) see the change.
          root.notify();
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
          if (result.error === undefined) waiting.resolve(result.value);
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
        private: { channel, table, exitPromise, fromName },
      };

    },
    async onMessage(msg: InMsg): Promise<HookResult> {
      const { channel, table, fromName } = this.state.private;
      // A message this side sends is for the root: that is the process the
      // proxy stands for, and a frame that names no process means it.
      channel?.send(encodeFrame({ $msg: { fromName, body: msg } }, table));
      return stopPropagation();
    },
    async onStopRequested() {
      const { channel, table, exitPromise, fromName } = this.state.private;
      if (channel) {
        channel.send(encodeFrame({ $msg: { fromName, body: { type: "STOP" } } }, table));
        await exitPromise;
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
