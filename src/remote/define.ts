// ── defineRemoteActor ──────────────────────────────────────────────────────
//
// Wraps an ActorDefinition so that when spawned, it runs in a child process
// over two named fifos. Returns { actor, runRemoteRoot, isRemoteRoot }.
//
// Uses defineActor's setup hook to spawn the remote child before the first
// yield, so proc.ready() shows the live remote state — same as local spawn.

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

export interface RemoteActorBundle<
  Args,
  ExposedState,
  InMsg extends Message,
  OutMsg extends Message,
  Handlers extends HandlerOptions<InMsg>,
> {
  actor: ActorDefinition<Args, ExposedState, InMsg, OutMsg, Handlers>;
  runRemoteRoot(): Promise<void>;
  isRemoteRoot: boolean;
}

function pathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

const MARKER_PREFIX = "--remote=";

type ProxyInternalState = {
  $remote: RemoteProxy | null;
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
): RemoteActorBundle<Args, ExposedState, InMsg, OutMsg, Handlers> {
  const scriptPath = fileURLToPath(url);
  const marker = `${MARKER_PREFIX}${pathHash(scriptPath)}`;
  const isRemoteRoot = !opts.manual && process.argv.includes(marker);

  if (isRemoteRoot) {
    runChild(actor.fn);
  }

  type IS = ProxyInternalState;
  type Ctx = ActorContext<Args, IS, InMsg, OutMsg, {}, Handlers>;

  const proxyDef = defineActor<Args, IS, ExposedState, InMsg, OutMsg, {}, Handlers>({
    name: actor.config.name ?? "actor",
    inMessages: actor.config.inMessages,
    outMessages: actor.config.outMessages,
    expose: (s: IS): ExposedState => s.$remote?.state as ExposedState,
    handlers: {} as unknown as Handlers,
    async setup(this: Ctx, args: Args): Promise<IS> {
      const remote = await spawnRemote<ExposedState, InMsg, OutMsg, Args>({
        command: ["bun", "run", scriptPath, marker],
        args: args,
      });
      remote.onMessage((msg: OutMsg) => {
        this.emit(msg);
      });
      return { $remote: remote };
    },
    hooks: {
      async onMessage(this: Ctx, msg: InMsg): Promise<HookResult> {
        this.state.$remote?.send(msg);
        return stopPropagation();
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
    actor: proxyDef,
    runRemoteRoot() {
      return runChild(actor.fn);
    },
    isRemoteRoot,
  };
}
