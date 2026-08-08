// ── defineRemoteActor ──────────────────────────────────────────────────────
//
// Wraps an ActorDefinition so that when spawned, it runs in a child process
// over two named fifos. Returns { actor, runRemoteRoot, isRemoteRoot }.
//
// The proxy is a real defineActor with hooks — local and remote actors
// share the same ActorDefinition type and are fully interchangeable.

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

type ProxyInternalState<ES> = {
  $remote: RemoteProxy | null;
  /** Initial exposed state computed locally — used until the remote connects. */
  $initial: ES;
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

  type IS = ProxyInternalState<ExposedState>;
  type Ctx = ActorContext<Args, IS, InMsg, OutMsg, {}, Handlers>;

  const proxyDef = defineActor<Args, IS, ExposedState, InMsg, OutMsg, {}, Handlers>({
    name: actor.config.name ?? "actor",
    inMessages: actor.config.inMessages,
    outMessages: actor.config.outMessages,
    initialState(args: Args, ctx: Ctx["ctx"]): IS {
      // Compute initial exposed state locally — matches a local spawn.
      const raw = typeof actor.config.initialState === "function"
        ? (actor.config.initialState as (args: Args, ctx: Ctx["ctx"]) => Record<string, unknown>)(args, ctx)
        : (actor.config.initialState as Record<string, unknown>);
      const exposed = actor.config.expose
        ? actor.config.expose(raw)
        : raw;
      return { $remote: null, $initial: exposed as unknown as ExposedState };
    },
    expose(s: IS): ExposedState {
      // Once connected, show the live remote state.  Before connection,
      // show the locally-computed initial state (matches local spawn).
      return (s.$remote?.state as ExposedState) ?? s.$initial;
    },
    handlers: {} as unknown as Handlers,
    async onStart(this: Ctx, args: Args) {
      const remote = await spawnRemote({
        command: ["bun", "run", scriptPath, marker],
        args: args as Record<string, unknown>,
      });
      this.state.$remote = remote;
      remote.onMessage((msg: Message) => {
        this.emit(msg as OutMsg);
      });
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
