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
import type { HandlerOptions } from "../actor-types.js";
import { defineActor } from "../define-actor.js";
import { stopPropagation } from "../hooks.js";
import { runChild } from "./child.js";
import { spawnRemote } from "./host.js";
import type { ActorDefinition } from "../actor-types.js";

export interface RemoteActorOptions {
  manual?: boolean;
}

function pathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

const MARKER_PREFIX = "--remote=";

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

  const proxyDef = defineActor<Args, any, ExposedState, InMsg, OutMsg, {}, Handlers>({
    name: actor.config.name ?? "actor",
    inMessages: actor.config.inMessages,
    outMessages: actor.config.outMessages,
    initialState: actor.config.initialState,
    expose: actor.config.expose,
    handlers: {} as unknown as Handlers,
    // onStart on the config (not hooks) fires with args
    async onStart(this: any, args: Args) {
      const remote = await spawnRemote({
        command: ["bun", "run", scriptPath, marker],
        args: args as Record<string, unknown>,
      });
      this.state.$remote = remote;
      remote.onMessage((msg: Message) => {
        this.emit(msg);
      });
    },
    hooks: {
      async onMessage(this: any, msg: InMsg) {
        this.state.$remote?.send(msg);
        return stopPropagation() as any;
      },
      async onStopRequested(this: any) {
        const remote = this.state.$remote;
        if (remote) {
          remote.send({ type: "STOP" });
          await remote.wait();
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
