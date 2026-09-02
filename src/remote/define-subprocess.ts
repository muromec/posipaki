// ── defineSubprocessActor ───────────────────────────────────────────────────
//
// Environment-specific glue: wraps an actor definition so that spawning it runs
// it in a subprocess over two named fifos. It does the guesswork — argv marker
// detection and runner auto-detection — and prepares the client spawner. This
// is the only place in the subprocess path that imports transports/protocols.

import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Message } from "../types.js";
import type { ActorDefinition, HandlerOptions, MethodOptions, ReflectionOptions } from "../actor-types.js";
import { remoteClient } from "./client.js";
import { serveRemoteActor } from "./server.js";
import { commandSpawner } from "./spawners/fifo-command.js";
import { fifoArgvSpawner } from "./spawners/fifo-argv.js";

export interface SubprocessActorOptions {
  manual?: boolean;
}

export interface SubprocessActorBundle<
  Args,
  State,
  InMsg extends Message,
  OutMsg extends Message,
  R extends ReflectionOptions,
> {
  actor: ActorDefinition<Args, State, InMsg, OutMsg, R>;
  runRemoteRoot(): Promise<void>;
  isRemoteRoot: boolean;
}

function pathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

const MARKER_PREFIX = "--remote=";

export function defineSubprocessActor<
  Args,
  State,
  InMsg extends Message,
  OutMsg extends Message,
  Methods extends MethodOptions,
  Handlers extends HandlerOptions<InMsg>,
  R extends ReflectionOptions,
>(
  actor: ActorDefinition<Args, State, InMsg, OutMsg, R>,
  url: string,
  opts: SubprocessActorOptions = {},
): SubprocessActorBundle<Args, State, InMsg, OutMsg, R> {
  const scriptPath = fileURLToPath(url);
  const marker = `${MARKER_PREFIX}${pathHash(scriptPath)}`;
  const isRemoteRoot = !opts.manual && process.argv.includes(marker);

  const serve = () => serveRemoteActor(actor, fifoArgvSpawner);

  if (isRemoteRoot) {
    void serve();
  }

  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  const runner = isBun ? "bun" : "node";
  const spawner = commandSpawner([runner, scriptPath, marker]);

  const proxyDef = remoteClient<Args, State, InMsg, OutMsg, Methods, Handlers, R>(
    actor.name ?? "actor",
    spawner,
  );

  return {
    actor: proxyDef,
    runRemoteRoot: serve,
    isRemoteRoot,
  };
}
