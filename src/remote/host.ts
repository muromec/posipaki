// ── Host-side adapter ──────────────────────────────────────────────────────
//
// Spawns a child process and returns a proxy that quacks like a posipaki
// process handle.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { FifoUtf8NlineTransport } from "./fifo.js";
import { encode, decode, isProto, isState, isMsg, isExit, PROTO_VERSION } from "./protocol.js";
import type { Message } from "../types.js";

export interface SpawnOptions {
  command: string[];
  args: Record<string, unknown>;
  parentName?: string;
}

export interface RemoteProxy {
  state: unknown;
  ready(): Promise<void>;
  send(msg: Message): void;
  wait(): Promise<{ code: number | null; state: unknown }>;
  onMessage(handler: (msg: Message) => void): void;
}

export async function spawnRemote(opts: SpawnOptions): Promise<RemoteProxy> {
  const basePath = join(tmpdir(), `posipaki-${randomUUID()}`);

  execSync(`mkfifo "${basePath}.in"`);
  execSync(`mkfifo "${basePath}.out"`);

  // Start opening the read fifo before spawning the child (deadlock prevention)
  const setup = FifoUtf8NlineTransport.beginConnect(basePath + ".in", basePath + ".out");

  const childCmd = [
    ...opts.command,
    `--fifo-in=${basePath + ".in"}`,
    `--fifo-out=${basePath + ".out"}`,
  ];
  const childProc: ChildProcess = spawn(childCmd[0], childCmd.slice(1), {
    cwd: process.cwd(),
    stdio: ["inherit", "inherit", "inherit"],
  });

  const transport = await setup.transport;

  // ── handshake ───────────────────────────────────────────────────────
  const protoLine = await new Promise<string>((resolve) => {
    transport.onMessage((line) => resolve(line));
  });
  const protoMsg = decode(protoLine);
  if (!isProto(protoMsg) || protoMsg.$proto !== PROTO_VERSION) {
    throw new Error(`unsupported protocol: ${protoLine.slice(0, 50)}`);
  }
  transport.removeHandler();

  await transport.send(encode("$init", {
    ...opts.args,
    parentName: opts.parentName ?? "host",
    parentIdName: opts.parentName ?? "host",
  }));

  let currentState: unknown = null;
  await new Promise<void>((resolve) => {
    transport.onMessage((line) => {
      const msg = decode(line);
      if (isState(msg)) {
        currentState = msg.$state;
        resolve();
      }
    });
  });
  transport.removeHandler();

  // ── persistent handler ──────────────────────────────────────────────
  let msgHandler: ((msg: Message) => void) | null = null;
  let exitResolver: ((value: { code: number | null; state: unknown }) => void) | null = null;
  const exitPromise = new Promise<{ code: number | null; state: unknown }>((resolve) => {
    exitResolver = resolve;
  });

  transport.onMessage((line) => {
    const msg = decode(line);
    if (isState(msg)) {
      currentState = msg.$state;
    } else if (isMsg(msg)) {
      msgHandler?.(msg.$msg.body as Message);
    } else if (isExit(msg)) {
      if (exitResolver) {
        exitResolver({ code: msg.$exit.code, state: msg.$exit.state });
        exitResolver = null;
      }
      cleanup();
    }
  });

  // ── cleanup ─────────────────────────────────────────────────────────
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    transport.close();
    unlink(basePath + ".in").catch(() => {});
    unlink(basePath + ".out").catch(() => {});
  };

  childProc.on("exit", (code) => {
    if (exitResolver) {
      exitResolver({ code, state: currentState });
      exitResolver = null;
    }
    cleanup();
  });

  return {
    get state() { return currentState; },
    async ready() {},
    send(msg: Message) {
      const from = opts.parentName ?? "host";
      transport.send(encode("$msg", { type: msg.type, fromName: from, body: msg }));
    },
    async wait() { return exitPromise; },
    onMessage(handler) { msgHandler = handler; },
  };
}
