// ── Running an actor on a host that is already there ───────────────────────
//
// The connector knows one thing: how to open a channel to a named host and run
// something on it.  It does not start anything, hold it, or care what else runs
// there — no host to reach, no channel, and what ssh says is the reason.
//
// Two knobs, and they are the whole way in:
//
//   prepare   optional — runs once before the actor, on the host, for an actor
//             that has to be put there first (see stage.ts for the kit);
//   command   what to run, as an argv, given what prepare left behind.

import type { ChildProcess, StdioOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { clientChannel, stderrSink } from "posipaki/remote/node";
import type { LineStreams, OutputFd, OutputSink } from "posipaki/remote/node";
import type { Channel, ClientSpawner } from "posipaki/remote";
import { sshEntry } from "./commands.js";
import { runHost } from "./host.js";
import type { HostResult, HostRun, SpawnChild } from "./host.js";
import { spawnChild as startOnHost } from "./host.js";
import { SshSpecError } from "./spec.js";

/** What a prepare step is handed: the host, and a way to run something on it. */
export interface SshPrepare {
  host: string;
  /** Run a command on the host and wait for what it said. */
  run(command: string[], stdin?: string): Promise<HostResult>;
}

/** A way into a host that is already there. */
export interface SshConnectSpec<Args, Prepared = void> {
  /** The host to reach, as ssh itself accepts it.  Required: this runs actors on hosts, it does not find them. */
  host: string;
  /** Runs once before the actor.  Optional: what the host already has needs nothing. */
  prepare?: (ctx: SshPrepare) => Promise<Prepared>;
  /** The actor's argv on the host, given what prepare left behind. */
  command: (args: Args, prepared: Prepared) => string[];
}

/** How the host's process is started and watched — everything but what runs on it. */
export interface SshConnectOptions {
  /** Where the host's own output goes.  Defaults to our stderr, tagged with the host. */
  onOutput?: OutputSink;
  /** How long to wait for the host's first protocol frame. */
  handshakeTimeoutMs?: number;
  /** Called when the host's process is gone, whichever way it went. */
  onGone?: () => void;
  /** How host commands run.  Injectable, so tests need no host. */
  runHost?: HostRun;
  /** How the host's process is started.  Injectable, so a test can hold the process. */
  spawnChild?: SpawnChild;
}

/** How much of what a failed host said we quote as the reason. */
const REASON_TAIL = 400;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start the run command and hand its own stdin/stdout to the wire.  A host that
 * dies before it speaks — a refused connection, a missing runtime — fails the
 * spawn with what it said, rather than a channel that never answers.
 */
async function openChannel(
  host: string,
  command: string[],
  options: SshConnectOptions,
): Promise<Channel> {
  const sink = options.onOutput ?? stderrSink(host);
  let tail = "";
  const output: OutputSink = (fd: OutputFd, data: string) => {
    if (fd === 2) tail = (tail + data).slice(-REASON_TAIL);
    sink(fd, data);
  };

  // The run's own stdin and stdout *are* the wire, so both have to be pipes.
  const stdio: StdioOptions = ["pipe", "pipe", "pipe"];
  const child: ChildProcess = (options.spawnChild ?? startOnHost)(command, stdio);
  const streams: LineStreams = { read: child.stdout as Readable, write: child.stdin as Writable };

  // The run's stdin and stdout are the wire; its stderr is not.  That is where
  // the way in itself speaks — "Permission denied (publickey)", "Could not
  // resolve hostname" — so it goes to the sink, and the tail of it becomes the
  // reason a host that dies early is reported with.
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => output(2, chunk));

  const exited = new Promise<never>((_, reject) => {
    // `close`, not `exit`: the process being gone is not the same as everything it
    // said having arrived, and the tail of its stderr is the whole reason here.
    child.once("close", (code, signal) => {
      const how = signal === null ? `code ${code}` : `signal ${signal}`;
      const why = tail.trim();
      reject(new Error(`the host exited with ${how}${why ? `: ${why}` : ""}`));
    });
    child.once("error", (err) => reject(new Error(`cannot start the host: ${err.message}`)));
  });
  // A spawn that resolves leaves this rejection unobserved — fine, as long as it
  // is not reported as an unhandled rejection.
  exited.catch(() => {});

  let channel: Channel;
  try {
    channel = await Promise.race([
      clientChannel(streams, {
        onOutput: output,
        ...(options.handshakeTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.handshakeTimeoutMs }),
      }),
      exited,
    ]);
  } catch (err) {
    child.kill();
    throw new SshSpecError(`ssh ${host} is not available: ${errorText(err)}`);
  }

  // The host's own exit is the channel's close: whichever side goes first, the
  // other stops waiting — and the caller is told, because its slot must stop
  // pointing at a process that is gone.
  child.once("exit", () => {
    options.onGone?.();
    void channel.close().catch(() => {});
  });
  return channel;
}

/**
 * The connector: the host is there, the actor is prepared if it has to be, and
 * it runs on the run's own stdin/stdout.  Nothing here starts or stops anything
 * — a host that cannot be reached fails, and says so.
 */
export function sshConnector<Args, Prepared = void>(
  spec: SshConnectSpec<Args, Prepared>,
  options: SshConnectOptions = {},
): ClientSpawner<Args> {
  const run = options.runHost ?? runHost;
  return async (args: Args): Promise<Channel> => {
    const prepared = spec.prepare
      ? await spec.prepare({
          host: spec.host,
          run: (command, stdin = "") => run(command, stdin),
        })
      : (undefined as Prepared);
    return openChannel(spec.host, sshEntry(spec.host, spec.command(args, prepared)), options);
  };
}
