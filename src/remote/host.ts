// ── Host-side adapter ──────────────────────────────────────────────────────
//
// commandConnector: spawns a child process and bridges the wire protocol.
// Connector wrappers (bunConnector, nodeConnector, defaultConnector) produce
// the command array from a script path.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { FifoUtf8NlineTransport } from "./fifo.js";
import { encode, decode, isProto, isState, isMsg, isExit, PROTO_VERSION } from "./protocol.js";
import type { Message } from "../types.js";

// ── types ──────────────────────────────────────────────────────────────────

export interface CommandSpawnOptions<Args = Record<string, unknown>> {
  command: string[];
  args: Args;
  parentName?: string;
}

export interface RemoteProxy<
  State = unknown,
  InMsg extends Message = Message,
  OutMsg extends Message = Message,
> {
  readonly state: State;
  ready(): Promise<void>;
  send(msg: InMsg): void;
  wait(): Promise<{ code: number | null; state: State }>;
  onMessage(handler: (msg: OutMsg) => void): void;
}

/** A connector takes a command and returns a RemoteProxy. */
export type Connector<
  State = unknown,
  InMsg extends Message = Message,
  OutMsg extends Message = Message,
> = (opts: CommandSpawnOptions) => Promise<RemoteProxy<State, InMsg, OutMsg>>;

// ── commandConnector ───────────────────────────────────────────────────────

export async function spawnRemote<
  State = unknown,
  InMsg extends Message = Message,
  OutMsg extends Message = Message,
  Args = Record<string, unknown>,
>(opts: CommandSpawnOptions<Args>): Promise<RemoteProxy<State, InMsg, OutMsg>> {
  const basePath = join(tmpdir(), `posipaki-${randomUUID()}`);

  execSync(`mkfifo "${basePath}.in"`);
  execSync(`mkfifo "${basePath}.out"`);

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

  await transport.send(
    encode("$init", {
      ...(opts.args as Record<string, unknown>),
      parentName: opts.parentName ?? "host",
      parentIdName: opts.parentName ?? "host",
    }),
  );

  let currentState: Record<string, unknown> = {};
  await new Promise<void>((resolve) => {
    transport.onMessage((line) => {
      const msg = decode(line);
      if (isState(msg)) {
        Object.assign(currentState, msg.$state as Record<string, unknown>);
        resolve();
      }
    });
  });
  transport.removeHandler();

  // ── persistent handler ──────────────────────────────────────────────
  let msgHandler: ((msg: OutMsg) => void) | null = null;
  let exitResolver: ((value: { code: number | null; state: State }) => void) | null = null;
  const exitPromise = new Promise<{ code: number | null; state: State }>((resolve) => {
    exitResolver = resolve;
  });

  transport.onMessage((line) => {
    const msg = decode(line);
    if (isState(msg)) {
      Object.assign(currentState, msg.$state as Record<string, unknown>);
    } else if (isMsg(msg)) {
      msgHandler?.(msg.$msg.body as OutMsg);
    } else if (isExit(msg)) {
      if (exitResolver) {
        exitResolver({ code: msg.$exit.code, state: msg.$exit.state as State });
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
      exitResolver({ code, state: currentState as State });
      exitResolver = null;
    }
    cleanup();
  });

  return {
    get state(): State {
      return currentState as State;
    },
    async ready() {},
    send(msg: InMsg) {
      const from = opts.parentName ?? "host";
      transport.send(encode("$msg", { fromName: from, body: msg }));
    },
    async wait() {
      return exitPromise;
    },
    onMessage(handler: (msg: OutMsg) => void) {
      msgHandler = handler;
    },
  };
}

// ── connector wrappers ─────────────────────────────────────────────────────

function scriptConnector(runner: string, runnerArgs: string[]): (scriptPath: string) => Connector {
  return (scriptPath: string) => {
    return ((opts: CommandSpawnOptions) => {
      return commandConnector({
        ...opts,
        command: [runner, ...runnerArgs, scriptPath, ...opts.command],
      });
    }) as Connector;
  };
}

/** Spawn via `bun run <script>`. */
export const bunConnector = scriptConnector("bun", ["run"]);

/** Spawn via `node <script>`. */
export const nodeConnector = scriptConnector("node", []);

/**
 * Auto-detect: prefers `bun run` if the script is a .ts file and bun is
 * the current runtime, otherwise falls back to `node`.
 */
export function defaultConnector(scriptPath: string): Connector {
  // Check if we're running under bun
  const isBun = typeof (globalThis as any).Bun !== "undefined";
  const isTs = scriptPath.endsWith(".ts");
  if (isBun && isTs) return bunConnector(scriptPath);
  return nodeConnector(scriptPath);
}

// ── alias ───────────────────────────────────────────────────────────────────

export const commandConnector = spawnRemote;
