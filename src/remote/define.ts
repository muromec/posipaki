// ── defineRemoteActor ──────────────────────────────────────────────────────
//
// Wraps an ActorDefinition so that when spawned, it runs in a child process
// over two named fifos. Returns a real ActorDefinition — local and remote
// actors are type-compatible and interchangeable.
//
//   const echo = defineActor({ ... });
//   const remoteEcho = defineRemoteActor(echo, import.meta.url);
//   const proc = remoteEcho.spawn({});  // AsyncProcess, same interface

import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Message } from "../types.js";
import type { ActorContext, HandlerOptions } from "../actor-types.js";
import { defineActor } from "../define-actor.js";
import { stopPropagation } from "../hooks.js";
import type { HookResult } from "../hooks.js";
import { runChild } from "./child.js";
import { spawnRemote } from "./host.js";
import type { RemoteProxy } from "./host.js";
import type { ActorDefinition } from "../actor-types.js";

export interface RemoteActorOptions {
  manual?: boolean;
}

function pathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

const MARKER_PREFIX = "--remote=";

type ProxyInternalState<ES> = {
  $remote: RemoteProxy | null;
  $state: ES;
};

export function defineRemoteActor<
  Args,
  ExposedState,
  InMsg extends Message,
  OutMsg extends Message,
  Handlers extends HandlerOptions<InMsg>,
>(
  actor: ActorDefinition<Args, ExposedState, InMsg, OutMsg, Handlers>,
  url: string,
  opts: RemoteActorOptions = {},
): ActorDefinition<Args, ExposedState, InMsg, OutMsg, Handlers> & { isChild: boolean } {
  const scriptPath = fileURLToPath(url);
  const marker = `${MARKER_PREFIX}${pathHash(scriptPath)}`;
  const isChild = !opts.manual && process.argv.includes(marker);

  if (isChild) {
    runChild(actor.fn);
  }

  type IS = ProxyInternalState<ExposedState>;
  type Ctx = ActorContext<Args, IS, InMsg, OutMsg, {}, Handlers>;

  const proxyDef = defineActor<Args, IS, ExposedState, InMsg, OutMsg, {}, Handlers>({
    name: actor.config.name ?? "actor",
    inMessages: actor.config.inMessages,
    outMessages: actor.config.outMessages,
    initialState: (): IS => ({
      $remote: null,
      $state: null as unknown as ExposedState,
    }),
    expose: (s: IS): ExposedState => s.$state,
    handlers: {} as unknown as Handlers,
    async onStart(this: Ctx, args: Args) {
      const remote = await spawnRemote({
        command: ["bun", "run", scriptPath, marker],
        args: args as Record<string, unknown>,
      });
      this.state.$remote = remote;
      this.state.$state = remote.state as ExposedState;
      remote.onMessage((msg: Message) => {
        this.emit(msg as OutMsg);
      });
    },
    hooks: {
      async onMessage(this: Ctx, msg: InMsg): Promise<HookResult> {
        this.state.$remote?.send(msg);
        return stopPropagation() as unknown as HookResult;
      },
      async onStopRequested(this: Ctx) {
        if (this.state.$remote) {
          this.state.$remote.send({ type: "STOP" });
          await this.state.$remote.wait();
        }
        this.agreeToStop();
      },
    },
  });

  return {
    ...proxyDef,
    isChild,
  };
}
