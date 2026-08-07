// ── Host-side adapter ──────────────────────────────────────────────────────
//
// Spawns a child process and returns a proxy that quacks like a posipaki
// process handle.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FifoTransport } from "./fifo.js";
import {
  encodeInit,
  encodeMsg,
  decode,
  isProto,
  isState,
  isMsg,
  isExit,
} from "./protocol.js";
import type { Message } from "../types.js";

export interface SpawnOptions {
  command: string[];
  args: Record<string, unknown>;
}

export interface RemoteProxy {
  state: unknown;
  ready(): Promise<void>;
  send(msg: Message, sender?: { fromName: string; fromId?: symbol }): void;
  wait(): Promise<{ code: number | null; state: unknown }>;
  onMessage(handler: (msg: Message, sender: { fromName: string; fromId: symbol }) => void): void;
}

export async function spawnRemote(opts: SpawnOptions): Promise<RemoteProxy> {
  const fifoPath = join(tmpdir(), `posipaki-${randomUUID()}.pipe`);

  execSync(`mkfifo "${fifoPath}"`);

  const childCmd = [...opts.command, `--fifo=${fifoPath}`];
  const childProc: ChildProcess = spawn(childCmd[0], childCmd.slice(1), {
    cwd: process.cwd(),
    stdio: ["inherit", "inherit", "inherit"],
  });
  
  const transport = await FifoTransport.open(fifoPath, "reader");
  
  // Read $proto
  const protoLine = await new Promise<string>((resolve) => {
    transport.onMessage((line) => resolve(line));
  });
  const protoMsg = decode(protoLine);
  if (!isProto(protoMsg) || protoMsg.$proto !== "ndjson.v1") {
    throw new Error(`unsupported protocol: ${protoLine.slice(0, 50)}`);
  }

  // Send $init
  await transport.send(encodeInit(opts.args));
  
  // Wait for first $state → ready
  let currentState: unknown = null;
  const readyPromise = new Promise<void>((resolve) => {
    transport.onMessage((line) => {
      const msg = decode(line);
      if (isState(msg)) {
        currentState = msg.$state;
        resolve();
      }
    });
  });
  await readyPromise;
  
  // Message handlers
  const msgHandlers: Array<(msg: Message, sender: { fromName: string; fromId: symbol }) => void> = [];
  let exitResolver: ((value: { code: number | null; state: unknown }) => void) | null = null;
  const exitPromise = new Promise<{ code: number | null; state: unknown }>((resolve) => {
    exitResolver = resolve;
  });

  // Process remaining messages
  transport.onMessage((line) => {
    const msg = decode(line);
    if (isState(msg)) {
      currentState = msg.$state;
    } else if (isMsg(msg)) {
      const { fromName, fromIdName: _fromIdName, body } = msg.$msg;
      const sender = { fromName, fromId: Symbol() };
      const fullMsg = body as Message;
      for (const h of msgHandlers) {
        h(fullMsg, sender);
      }
    } else if (isExit(msg)) {
      if (exitResolver) {
        exitResolver({ code: msg.$exit.code, state: msg.$exit.state });
        exitResolver = null;
      }
      hostClose();
    }
  });

  // Watch child process
  let hostClosed = false;
  const hostClose = () => {
    if (hostClosed) return;
    hostClosed = true;
    transport.close();
  };

  childProc.on("exit", (code) => {
    if (exitResolver) {
      exitResolver({ code, state: currentState });
      exitResolver = null;
    }
    hostClose();
  });

  return {
    state: currentState,

    async ready() {},

    send(msg: Message, sender = { fromName: "host", fromId: Symbol() }) {
      const fromIdName = sender.fromId ? (Symbol.keyFor(sender.fromId) ?? undefined) : undefined;
      transport.send(encodeMsg(msg.type, sender.fromName, fromIdName, msg));
    },

    async wait() {
      return exitPromise;
    },

    onMessage(handler) {
      msgHandlers.push(handler);
    },
  };
}
