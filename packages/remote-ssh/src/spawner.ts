// ── The way in as a spawner ────────────────────────────────────────────────
//
// A spawner is what the remote seam asks for: hand it the args the client was
// spawned with, and it returns a channel.  Here that is two channels into the
// same host — the kit goes up over one, the actor speaks over the other — and
// the host's own output is kept out of the protocol all the way.

import type { ChildProcess, StdioOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { clientChannel, stderrSink } from "posipaki/remote/node";
import type { LineStreams, OutputFd, OutputSink } from "posipaki/remote/node";
import type { Channel, ClientSpawner } from "posipaki/remote";
import { sshRunCommand } from "./commands.js";
import { spawnChild as startOnHost } from "./host.js";
import type { HostRun, SpawnChild } from "./host.js";
import { SshSpecError } from "./spec.js";
import type { SshSpec, SshStaged } from "./spec.js";
import { sshStage } from "./stage.js";

/** How the host is reached and watched — everything but what runs on it. */
export interface SshHostOptions {
  /** Where the host's own output goes.  Defaults to our stderr, tagged with the host. */
  onOutput?: OutputSink;
  /** How long to wait for the host's first protocol frame. */
  handshakeTimeoutMs?: number;
  /** Called when the host's process is gone, whichever way it went. */
  onGone?: () => void;
  /** How host commands run while staging.  Injectable, so tests need no host. */
  runHost?: HostRun;
  /** How the host's process is started.  Injectable, so a test can hold the process. */
  spawnChild?: SpawnChild;
}

export interface SshSpawnerOptions<Args> extends SshHostOptions {
  /**
   * The payload's own arguments, built from the args the client was spawned
   * with.  This package knows where the payload is and how it is started, not
   * what it wants to be told.
   */
  args?: (args: Args, staged: SshStaged) => string[];
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
  spec: SshSpec,
  command: string[],
  options: SshHostOptions,
): Promise<Channel> {
  const sink = options.onOutput ?? stderrSink(spec.host);
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
    child.once("exit", (code, signal) => {
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
    throw new SshSpecError(`ssh ${spec.host} is not available: ${errorText(err)}`);
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
 * The ssh way in: stage the kit over one ssh, then run the actor over a second
 * one whose own stdin/stdout are the wire.  Every spawn stages — the host probes
 * first, so an actor that is already there is not written again.
 */
export function sshSpawner<Args>(
  spec: SshSpec,
  options: SshSpawnerOptions<Args> = {},
): ClientSpawner<Args> {
  return async (args: Args): Promise<Channel> => {
    const staged = await sshStage(spec, options.runHost ? { runHost: options.runHost } : {});
    const argv = sshRunCommand(spec, staged, options.args?.(args, staged) ?? []);
    return openChannel(spec, argv, options);
  };
}
