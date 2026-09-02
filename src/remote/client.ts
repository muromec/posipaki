// ── Client-side adapter ──────────────────────────────────────────────────────
//
// The seam's client side: `connectRemote` runs the wire handshake and pumps
// state/messages over an already-established transport (transport-agnostic).
// `commandConnector` is the process bootstrap — it spawns the server, builds
// the FIFO transport, and connects over it.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { FifoUtf8NlineTransport } from "./fifo.js";
import { encode, decode, isProto, isState, isMsg, isExit, PROTO_VERSION } from "./protocol.js";
import type { Message } from "../types.js";
import type { Transport } from "./transport.js";

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

export interface ConnectOptions<Args = Record<string, unknown>> {
  args: Args;
  parentName?: string;
}

// ── connectRemote ───────────────────────────────────────────────────────────

export async function connectRemote<
  State = unknown,
  InMsg extends Message = Message,
  OutMsg extends Message = Message,
  Args = Record<string, unknown>,
>(transport: Transport, opts: ConnectOptions<Args>): Promise<RemoteProxy<State, InMsg, OutMsg>> {
  // 1. await $proto and validate the version
  const protoLine = await new Promise<string>((resolve) => {
    transport.onMessage((line) => resolve(line));
  });
  const protoMsg = decode(protoLine);
  if (!isProto(protoMsg) || protoMsg.$proto !== PROTO_VERSION) {
    throw new Error(`unsupported protocol: ${protoLine.slice(0, 50)}`);
  }
  transport.removeHandler();

  // 2. send $init (domain args + parent identity)
  const parentName = opts.parentName ?? "client";
  await transport.send(
    encode("$init", {
      ...(opts.args as Record<string, unknown>),
      parentName,
      parentIdName: parentName,
    }),
  );

  // 3. await the first $state (the server's ready signal)
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

  // 4. persistent pump
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
    }
  });

  // 5. return the proxy
  return {
    get state(): State {
      return currentState as State;
    },
    async ready() {},
    send(msg: InMsg) {
      transport.send(encode("$msg", { fromName: parentName, body: msg }));
    },
    async wait() {
      return exitPromise;
    },
    onMessage(handler: (msg: OutMsg) => void) {
      msgHandler = handler;
    },
  };
}

// ── commandConnector (process bootstrap) ───────────────────────────────────

export async function commandConnector<
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

  const proxy = await connectRemote<State, InMsg, OutMsg, Args>(transport, {
    args: opts.args,
    parentName: opts.parentName,
  });

  // Coordinate exit: a graceful $exit (proxy.wait) or a crash (child exit).
  const exitPromise = new Promise<{ code: number | null; state: State }>((resolve) => {
    proxy.wait().then(resolve);
    childProc.on("exit", (code) => resolve({ code, state: proxy.state }));
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    transport.close();
    unlink(basePath + ".in").catch(() => {});
    unlink(basePath + ".out").catch(() => {});
  };
  exitPromise.then(cleanup);

  return {
    ...proxy,
    async wait() {
      return exitPromise;
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
export const bunConnector = scriptConnector("bun", []);

/** Spawn via `node <script>`. */
export const nodeConnector = scriptConnector("node", []);

/**
 * Auto-detect: prefers `bun run` if bun is
 * the current runtime, otherwise falls back to `node`.
 */
export function defaultConnector(scriptPath: string): Connector {
  // Check if we're running under bun
  const isBun = typeof (globalThis as any).Bun !== "undefined";
  if (isBun) return bunConnector(scriptPath);
  return nodeConnector(scriptPath);
}
