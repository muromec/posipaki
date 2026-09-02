// ── defineRemoteActor ──────────────────────────────────────────────────────
//
// Wraps an ActorDefinition so that when spawned, it runs in a server process
// over two named fifos. Returns { actor, runRemoteRoot, isRemoteRoot }.
//
// Uses defineActor's setup hook to spawn the remote server before the first
// yield, so proc.ready() shows the live remote state — same as local spawn.

import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Message } from "../types.js";
import type { HandlerOptions, MethodOptions, ReflectionOptions } from "../actor-types.js";
import { defineActor } from "../define-actor.js";
import { stopPropagation } from "../hooks.js";
import type { HookResult } from "../hooks.js";
import { serveRemoteActor } from "./server.js";
import { type Connector, defaultConnector } from "./client.js";
import type { RemoteProxy } from "./client.js";
import type { ActorDefinition } from "../actor-types.js";

export interface RemoteActorOptions {
  manual?: boolean;
  connector?: Connector;
}

export interface RemoteActorBundle<
  Args,
  State,
  InMsg extends Message,
  OutMsg extends Message,
  ReflectionMethods extends ReflectionOptions,
> {
  actor: ActorDefinition<Args, State, InMsg, OutMsg, ReflectionMethods>;
  runRemoteRoot(): Promise<void>;
  isRemoteRoot: boolean;
}

function pathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

const MARKER_PREFIX = "--remote=";

export function defineRemoteActor<
  Args,
  State,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  Handlers extends HandlerOptions<InMsg>,
  Reflection extends ReflectionOptions,
>(
  actor: ActorDefinition<Args, State, InMsg, OutMsg, Reflection>,
  url: string,
  opts: RemoteActorOptions = {},
): RemoteActorBundle<Args, State, InMsg, OutMsg, Reflection> {
  const scriptPath = fileURLToPath(url);
  const marker = `${MARKER_PREFIX}${pathHash(scriptPath)}`;
  const isRemoteRoot = !opts.manual && process.argv.includes(marker);

  if (isRemoteRoot) {
    serveRemoteActor(actor.fn);
  }

  const proxyDef = defineActor<
    Args,
    { public: State; private: { remote: RemoteProxy<State, InMsg, OutMsg> } },
    InMsg,
    OutMsg,
    Methods,
    Handlers,
    Reflection
  >({
    name: actor.name ?? "actor",
    inMessages: actor.inMessages,
    outMessages: actor.outMessages,
    handlers: {} as unknown as Handlers,
    async setup(args: Args) {
      const connect = opts.connector ?? defaultConnector(scriptPath);
      const remote = (await connect({
        command: [marker],
        args: args as Record<string, unknown>,
      })) as RemoteProxy<State, InMsg, OutMsg>;
      remote.onMessage((msg: OutMsg) => {
        this.emit(msg);
      });
      return {
        public: remote.state,
        private: { remote },
      };
    },
    async onMessage(msg: InMsg): Promise<HookResult> {
      this.state.private.remote?.send(msg);
      return stopPropagation();
    },
    async onStopRequested() {
      if (this.state.private.remote) {
        this.state.private.remote.send({ type: "STOP" } as InMsg);
        await this.state.private.remote.wait();
      }
      this.agreeToStop();
    },
  });

  return {
    actor: proxyDef as ActorDefinition<Args, State, InMsg, OutMsg, Reflection>,
    runRemoteRoot() {
      return serveRemoteActor(actor.fn);
    },
    isRemoteRoot,
  };
}
