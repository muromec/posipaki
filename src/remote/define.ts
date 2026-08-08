// ── defineRemoteActor ──────────────────────────────────────────────────────
//
// Wraps an ActorDefinition so that when spawned, it runs in a child process
// over two named fifos. Returns { actor, runRemoteRoot, isRemoteRoot }.
//
// Uses a raw AsyncProcessFn instead of defineActor hooks because the proxy
// must yield the live remote state on every tick.  defineActor's
// runDispatchAsync yields null, which would hide state updates.

import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { AsyncProcessFn, Message } from "../types.js";
import type { ProcessCtx as PCtx } from "../types.js";
import { runChild } from "./child.js";
import { spawnRemote } from "./host.js";

import { spawnAsync } from "../process.async.js";
import type { ActorDefinition } from "../actor-types.js";
import type { HandlerOptions } from "../actor-types.js";

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

  const proxyFn: AsyncProcessFn<Args, ExposedState, InMsg, OutMsg> = async function* (
    ctx: PCtx<Args, ExposedState, InMsg, OutMsg>,
    args: Args,
  ) {
    const remote = await spawnRemote({
      command: ["bun", "run", scriptPath, marker],
      args: args as Record<string, unknown>,
    });

    remote.onMessage((msg) => {
      ctx.toParent(msg as OutMsg);
    });

    // Yield the live remote state on every tick so proc.state tracks it.
    let msg = yield remote.state as ExposedState;

    while (true) {
      if (msg[0].type === "STOP") {
        remote.send(msg[0]);
        await remote.wait();
        return;
      }
      remote.send(msg[0]);
      msg = yield remote.state as ExposedState;
    }
  };

  return {
    actor: {
      ...actor,
      fn: proxyFn as unknown as typeof actor.fn,
      spawn(args: Args) {
        return spawnAsync(
          proxyFn as unknown as AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>,
          actor.config.name ?? "actor",
        )(args);
      },
      spawnAsChild(ctx: PCtx<any, any, any, any>, args: Args, name?: string) {
        return ctx.fork(
          proxyFn as unknown as AsyncProcessFn<Args, ExposedState, InMsg, OutMsg>,
          name ?? actor.config.name ?? "child",
        )(args);
      },
    },
    runRemoteRoot() {
      return runChild(actor.fn);
    },
    isRemoteRoot,
  };
}
