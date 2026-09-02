// ── FIFO client spawner (command) ──────────────────────────────────────────
//
// Environment-specific: spawns a command, creates the two named fifos, and
// returns a frame Channel with the $proto handshake already validated.

import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { FifoUtf8NlineTransport } from "../transports/fifo.js";
import { json1Channel, VERSION } from "../protocols/json1.js";
import { isProto } from "../channel.js";
import type { Channel } from "../channel.js";

export function commandSpawner(command: string[]): () => Promise<Channel> {
  return async () => {
    const basePath = join(tmpdir(), `posipaki-${randomUUID()}`);

    execSync(`mkfifo "${basePath}.in"`);
    execSync(`mkfifo "${basePath}.out"`);

    const setup = FifoUtf8NlineTransport.beginConnect(basePath + ".in", basePath + ".out");

    const childCmd = [
      ...command,
      `--fifo-in=${basePath + ".in"}`,
      `--fifo-out=${basePath + ".out"}`,
    ];
    const childProc = spawn(childCmd[0], childCmd.slice(1), {
      cwd: process.cwd(),
      stdio: ["inherit", "inherit", "inherit"],
    });

    const transport = await setup.transport;
    const channel = json1Channel(transport);

    const protoFrame = await new Promise<Record<string, unknown>>((resolve) => {
      channel.onMessage((frame) => resolve(frame));
    });
    channel.removeHandler();
    if (!isProto(protoFrame) || protoFrame.$proto !== VERSION) {
      throw new Error(`unsupported protocol: ${JSON.stringify(protoFrame).slice(0, 50)}`);
    }

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      transport.close();
      unlink(basePath + ".in").catch(() => {});
      unlink(basePath + ".out").catch(() => {});
    };
    childProc.on("exit", cleanup);

    return channel;
  };
}
