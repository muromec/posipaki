// ── FIFO client spawner (command) ──────────────────────────────────────────
//
// Environment-specific: spawns a command, makes the two named fifos it is to serve on, and hands back
// the frame Channel whose far side is that child.  The pair's own half is fifo.ts's — connect, and wait
// for the `$proto` — so what is left here is the child, the paths in its argv, and the cleanup.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { Channel } from "../channel.js";
import { fifoClientSpawner, makeFifoPair } from "../fifo.js";

export function commandSpawner(command: string[]): () => Promise<Channel> {
  return async () => {
    const basePath = join(tmpdir(), `posipaki-${randomUUID()}`);
    // The pair as the child meets it: it reads `.out` and writes `.in`.  Made before the child exists,
    // so the child's own open finds it waiting rather than making it late.
    await makeFifoPair({ read: `${basePath}.out`, write: `${basePath}.in` });

    const child = spawn(
      command[0],
      [...command.slice(1), `--fifo-in=${basePath}.in`, `--fifo-out=${basePath}.out`],
      {
        cwd: process.cwd(),
        stdio: ["inherit", "inherit", "inherit"],
      },
    );

    const channel = await fifoClientSpawner<unknown>({
      read: `${basePath}.out`,
      write: `${basePath}.in`,
    })(undefined);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      void channel.close();
      unlink(`${basePath}.in`).catch(() => {});
      unlink(`${basePath}.out`).catch(() => {});
    };
    child.on("exit", cleanup);

    return channel;
  };
}
