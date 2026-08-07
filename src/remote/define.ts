// ── defineRemoteActor ──────────────────────────────────────────────────────
//
// One-file wrapper: import on the host side, execute on the child side.
//
//   export const myRemoteActor = defineRemoteActor(MyActor.fn, import.meta.url);

import { fileURLToPath } from "node:url";
import type { AsyncProcessFn, Message, ProcessCtx } from "../types.js";
import { runChild } from "./child.js";
import { spawnRemote } from "./host.js";
import type { RemoteProxy } from "./host.js";

export interface RemoteActorDefinition<Args> {
  runChild(): Promise<void>;
  spawn(
    ctx: ProcessCtx<unknown, unknown, Message, Message> | null,
  ): (args: Args) => Promise<RemoteProxy>;
}

export function defineRemoteActor(
  fn: AsyncProcessFn<any, any, any, any>,
  url: string,
): RemoteActorDefinition<any> {
  const scriptPath = fileURLToPath(url);
  const isChild = process.argv.some((a) => a.startsWith("--fifo="));

  if (isChild) {
    runChild(fn);
  }

  return {
    runChild() {
      return runChild(fn);
    },

    spawn(_ctx) {
      return (args: any) => {
        return spawnRemote({
          command: ["bun", "run", scriptPath],
          args: args,
        }) as Promise<RemoteProxy>;
      };
    },
  };
}
