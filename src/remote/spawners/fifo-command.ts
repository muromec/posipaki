// ── FIFO client spawner (command) ──────────────────────────────────────────
//
// The other end of a payload: makes the pair, spawns the command with both paths in its argv, opens this side
// as bytes, and returns the seam's frames.  Cleaning up the pair when the child exits is what is left here.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import type { Channel } from "../channel.js";
import { makeFifoPair } from "../fifo.js";
import { jsonSeam } from "../seam.js";
import { fifoByteChannel } from "./fifo-port.js";

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

    // This side reads what the payload writes and writes what it reads; the seam composes the frames over
    // the octets, so the medium hands up bytes and nothing else.
    const channel = await jsonSeam(async () => fifoByteChannel(`${basePath}.in`, `${basePath}.out`, "client"))(
      undefined,
    );

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
