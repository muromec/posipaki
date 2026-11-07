// ── a spawned command as a port ─────────────────────────────────────────────
//
// The child's stdout is the channel's frames, its stdin is what `send` writes, and the way it ended is the
// channel's close reason.  Nothing else crosses: a child's stderr is discarded, because stderr is a stream the
// child writes while it runs and not a fact about how it ended.  `spawnPorts` is the same process with both of
// its output streams.
//
// Closing is stdin's end of stream first.  A program that reads its input exits on EOF, which is the polite
// half; the process is killed `killAfterMs` later if it is still there, which is the other half.

import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

import type { Channel } from "../channel.js";

/** How a process ended: what the shell reports. */
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface SpawnPortOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** How long the process may live after its stdin is closed.  Default 5000 ms, then SIGKILL. */
  killAfterMs?: number;
}

export interface ProcessPorts {
  readonly stdout: Channel<Uint8Array, ProcessExit>;
  readonly stderr: Channel<Uint8Array, ProcessExit>;
}

const DEFAULT_KILL_AFTER_MS = 5_000;

/** A command as a channel of bytes: stdout in, stdin out, and its exit when it closes. */
export function spawnPort(
  command: string[],
  options: SpawnPortOptions = {},
): Promise<Channel<Uint8Array, ProcessExit>> {
  return spawnPorts(command, options).then((ports) => ports.stdout);
}

/** One process, its stdout and its stderr, each a channel that ends with the same exit. */
export async function spawnPorts(
  command: string[],
  options: SpawnPortOptions = {},
): Promise<ProcessPorts> {
  const [file, ...args] = command;
  if (file === undefined) throw new Error("spawnPort: there is no command to run");

  const child = spawn(file, args, { cwd: options.cwd, env: options.env });
  await started(child, file);

  const out = bytesOf(child.stdout);
  const err = bytesOf(child.stderr);

  let exit: ProcessExit | null = null;
  let ended = false;
  const closers = new Set<(reason: ProcessExit) => void>();
  const failers = new Set<(error: unknown) => void>();

  const end = (why: ProcessExit): void => {
    if (ended) return;
    ended = true;
    exit = why;
    for (const closer of [...closers]) closer(why);
  };

  child.on("error", (error) => {
    for (const failer of [...failers]) failer(error);
  });
  // `close` rather than `exit`: it follows the end of both streams, so no frame is lost behind the ending.
  child.on("close", (code, signal) => end({ code, signal }));

  const close = (reason?: string): Promise<void> =>
    shutdown(child, options.killAfterMs ?? DEFAULT_KILL_AFTER_MS).catch(() => undefined);

  const onClose = (handler: (reason: ProcessExit) => void): (() => void) => {
    if (exit !== null) {
      handler(exit);
      return () => {};
    }
    closers.add(handler);
    return () => {
      closers.delete(handler);
    };
  };

  const onError = (handler: (error: unknown) => void): (() => void) => {
    failers.add(handler);
    return () => {
      failers.delete(handler);
    };
  };

  const stderr: Channel<Uint8Array, ProcessExit> = {
    send: () => Promise.reject(new Error("stderr carries the process's output; it has no input")),
    onFrame: err.onFrame,
    onClose,
    onError,
    close,
  };

  return {
    stdout: { send: (frame) => write(child, frame), onFrame: out.onFrame, onClose, onError, close },
    stderr,
  };
}

/** Resolves once the child exists, rejects when the command could not be started at all. */
function started(child: ChildProcess, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error: Error) =>
      reject(new Error(`spawnPort: could not start ${file}: ${error.message}`)),
    );
  });
}

/** One output stream as frames, with its own readers.  A frame that arrives before the first reader is held. */
function bytesOf(stream: Readable | null): {
  onFrame: (handler: (frame: Uint8Array) => void) => () => void;
} {
  const readers = new Set<(frame: Uint8Array) => void>();
  const held: Uint8Array[] = [];
  stream?.on("data", (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (readers.size === 0) {
      held.push(bytes);
      return;
    }
    for (const reader of [...readers]) reader(bytes);
  });
  return {
    onFrame(handler) {
      readers.add(handler);
      for (let next = held.shift(); next !== undefined; next = held.shift()) handler(next);
      return () => {
        readers.delete(handler);
      };
    },
  };
}

/** Writes to the child's stdin, and settles when the write is out. */
function write(child: ChildProcess, frame: Uint8Array): Promise<void> {
  const stdin = child.stdin;
  if (stdin === null || stdin.destroyed) return Promise.reject(new Error("the process's stdin is closed"));
  return new Promise((resolve, reject) => {
    stdin.write(frame, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });
}

/** Ends stdin, and kills what is still there after the grace. */
async function shutdown(child: ChildProcess, killAfterMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  child.stdin?.end();
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, killAfterMs);
  timer.unref?.();
  await closed;
  clearTimeout(timer);
}
