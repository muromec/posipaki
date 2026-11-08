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
import { held } from "../held.js";
import type { Channel } from "../channel.js";
/** How a process ended: it exited with a code, or a signal terminated it. */
export type ProcessEnd =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: string };
export interface SpawnPortOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** How long the process may live after its stdin is closed.  Default 5000 ms, then SIGKILL. */
  killAfterMs?: number;
}
export interface ProcessPorts {
  readonly stdout: Channel<Uint8Array, ProcessEnd>;
  readonly stderr: Channel<Uint8Array, ProcessEnd>;
}
const DEFAULT_KILL_AFTER_MS = 5_000;
/** A command as a channel of bytes: stdout in, stdin out, and its exit when it closes. */
export function spawnPort(
  command: string[],
  options: SpawnPortOptions = {},
): Promise<Channel<Uint8Array, ProcessEnd>> {
  return spawnPorts(command, options).then((ports) => ports.stdout);
}
/** One process, its stdout and its stderr, each a channel that ends with the same exit. */
export async function spawnPorts(
  command: string[],
  options: SpawnPortOptions = {},
): Promise<ProcessPorts> {
  const [file, ...args] = command;
  if (file === undefined) throw new Error("spawnPort: there is no command to run");
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, detached: true });
  await started(child, file);
  const out = bytesOf(child.stdout, "stdout");
  const err = bytesOf(child.stderr, "stderr");
  let exit: ProcessEnd | null = null;
  let ended = false;
  const closers = new Set<(reason: ProcessEnd) => void>();
  const failers = new Set<(error: unknown) => void>();
  const end = (why: ProcessEnd): void => {
    if (ended) return;
    ended = true;
    exit = why;
    for (const closer of [...closers]) closer(why);
  };
  child.on("error", (error) => {
    for (const failer of [...failers]) failer(error);
  });
  // `close` rather than `exit`: it follows the end of both streams, so no frame is lost behind the ending.
  // Node gives a code or a signal and never both; that is the OS's one status word, split in two.
  child.on("close", (code, signal) =>
    end(code !== null ? { kind: "exit", code } : { kind: "signal", signal: signal ?? "unknown" }),
  );
  const close = (reason?: string): Promise<void> => {
    return shutdown(child, options.killAfterMs ?? DEFAULT_KILL_AFTER_MS).catch(() => undefined);
  };
  const onClose = (handler: (reason: ProcessEnd) => void): (() => void) => {
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
  // What only a process knows, and the one command it takes: a signal for the process and its children.
  const facts = {
    info: { pid: child.pid },
    control: (command: Record<string, unknown>): void => {
      const signal = command.signal;
      if (typeof signal === "string") signalGroup(child, signal as NodeJS.Signals);
    },
  };
  const stderr: Channel<Uint8Array, ProcessEnd> = {
    send: () => Promise.reject(new Error("stderr carries the process's output; it has no input")),
    onFrame: err.onFrame,
    onClose,
    onError,
    close,
    ...facts,
  };
  const stdout: Channel<Uint8Array, ProcessEnd> = {
    send: (frame: Uint8Array) => write(child, frame),
    onFrame: out.onFrame,
    onClose,
    onError,
    close,
    ...facts,
  };
  return { stdout, stderr };
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
/** One output stream as the frames of a channel, kept until somebody reads them. */
function bytesOf(stream: Readable | null, label: string): Channel<Uint8Array, ProcessEnd> {
  const readers = new Set<(frame: Uint8Array) => void>();
  const frames: Channel<Uint8Array, ProcessEnd> = {
    send: () => Promise.reject(new Error(`${label} carries the process's output; it has no input`)),
    onFrame(handler) {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    // The stream ending is not the process ending: the port reports that, from the process's own exit.
    onClose: () => () => {},
    onError: () => () => {},
    close: () => Promise.resolve(),
    info: {},
    control: () => {},
  };
  stream?.on("data", (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (const reader of [...readers]) reader(bytes);
  });
  return held(frames);
}
/** Writes to the child's stdin, and settles when the write is out. */
function write(child: ChildProcess, frame: Uint8Array): Promise<void> {
  const stdin = child.stdin;
  if (stdin === null || stdin.destroyed) return Promise.reject(new Error("the process's stdin is closed"));
  return new Promise((resolve, reject) => {
    stdin.write(frame, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });
}
/** Signal the child's process group, or the child alone when it has none. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    // The negative id is the group a detached child leads: its own children are in it too.
    process.kill(-pid, signal);
    return;
  } catch {
    /* no group of that number: this is one process after all */
  }
  try {
    child.kill(signal);
  } catch {
    /* gone */
  }
}

/** Ends stdin, and kills what is still there after the grace.  A caller in a hurry sends `signal` first. */
async function shutdown(child: ChildProcess, killAfterMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  child.stdin?.end();
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup(child, "SIGKILL");
  }, killAfterMs);
  timer.unref?.();
  await closed;
  clearTimeout(timer);
}
