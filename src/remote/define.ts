// ⚠️ WIP — child mode detection via --remote=<hash> marker.
// ── defineRemoteActor ──────────────────────────────────────────────────────
//
// One-file wrapper: import on the host side, execute on the child side.
//
//   export const myRemoteActor = defineRemoteActor(MyActor.fn, import.meta.url);

import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { ProcessCtx, Message } from "../types.js";
import { runChild } from "./child.js";
import { spawnRemote } from "./host.js";
import type { RemoteProxy } from "./host.js";

export interface RemoteActorOptions {
  manual?: boolean;
}

export interface RemoteActorDefinition<Args> {
  isChild: boolean;
  runChild(): Promise<void>;
  spawn(
    ctx: ProcessCtx<unknown, unknown, Message, Message> | null,
  ): (args: Args) => Promise<RemoteProxy>;
}

function pathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

const MARKER_PREFIX = "--remote=";

export function defineRemoteActor(
  fn: Parameters<typeof runChild>[0],
  url: string,
  opts: RemoteActorOptions = {},
): RemoteActorDefinition<Record<string, unknown>> {
  const scriptPath = fileURLToPath(url);
  const marker = `${MARKER_PREFIX}${pathHash(scriptPath)}`;

  const isChild = !opts.manual && process.argv.includes(marker);

  if (isChild) {
    runChild(fn);
  }

  return {
    isChild,

    runChild() {
      return runChild(fn);
    },

    spawn(_ctx) {
      return (args: Record<string, unknown>) => {
        return spawnRemote({
          command: ["bun", "run", scriptPath, marker],
          args: args,
        });
      };
    },
  };
}
