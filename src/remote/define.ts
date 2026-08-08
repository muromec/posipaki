// ── defineRemoteActor ──────────────────────────────────────────────────────
//
// Wraps an ActorDefinition so that when spawned, it runs in a child process
// over two named fifos. Returns a real ActorDefinition — local and remote
// actors are type-compatible and interchangeable.
//
//   const echo = defineActor({ ... });
//   const remoteEcho = defineRemoteActor(echo, import.meta.url);
//   const proc = remoteEcho.spawn({});  // AsyncProcess, same as echo.spawn({})

import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { AsyncProcessFn, Message } from "../types.js";
import type { HandlerOptions } from "../actor-types.js";
import type { ProcessCtx as PCtx } from "../types.js";
import { runChild } from "./child.js";
import { spawnRemote } from "./host.js";
import { spawnAsync } from "../process.async.js";
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
    runChild(actor.fn as unknown as Parameters<typeof runChild>[0]);
  }

  const proxyFn: AsyncProcessFn<Args, ExposedState, InMsg, OutMsg> = async function* (
    ctx: PCtx<Args, ExposedState, InMsg, OutMsg>,
    args: Args,
  ) {
    const remote = await spawnRemote({
      command: ["bun", "run", scriptPath, marker],
      args: args as Record<string, unknown>,
    });

    // Forward child emits → parent
    remote.onMessage((msg) => {
      ctx.toParent(msg as OutMsg);
    });

    yield remote.state as ExposedState;

    let msg = yield remote.state as ExposedState;

    while (true) {
      if (msg[0].type === "STOP") {
        remote.send(msg[0]);
        await remote.wait();
        return;
      }
      remote.send(msg[0]);
      msg = yield (remote.state as ExposedState);
    }
  };

  return {
    ...actor,
    fn: proxyFn,
    spawn(args: Args) {
      return spawnAsync(
        proxyFn,
        actor.config.name ?? "actor",
      )(args);
    },
    spawnAsChild(
      ctx: PCtx<any, any, any, any>,
      args: Args,
      name?: string,
    ) {
      return ctx.fork(
        proxyFn,
        name ?? actor.config.name ?? "child",
      )(args);
    },
    isChild,
  };
}
