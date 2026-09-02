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
import { isState, isMsg, isExit } from "./channel.js";

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
      await new Promise<void>((resolve) => {
        channel.onMessage((frame) => {
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
        } else if (isMsg(frame)) {
          this.emit(frame.$msg.body as OutMsg);
        } else if (isExit(frame)) {
          if (exitResolver) {
            exitResolver({ code: frame.$exit.code, state: frame.$exit.state as State });
            exitResolver = null;
          }
        }
      });
      channel.onClose(() => {
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
  });

  return proxyDef as unknown as ActorDefinition<Args, State, InMsg, OutMsg, R>;
}
