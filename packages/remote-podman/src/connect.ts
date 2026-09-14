// ── Running an actor in a container that is already there ──────────────────
//
// The connector knows one thing: how to open a channel into a named container
// and run something in it.  It does not start containers, hold them, or care who
// else is in there — no container, no channel, and what podman says is the reason.
//
// Two knobs, and they are the whole way in:
//
//   prepare   optional — runs once before the actor, in the container, for an
//             actor that has to be put there first (see stage.ts for the staging);
//   command   what to run, as an argv, given what prepare left behind.

import type { ChildProcess, StdioOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { clientChannel, stderrSink } from "posipaki/remote/node";
import type { LineStreams, OutputFd, OutputSink } from "posipaki/remote/node";
import type { Channel, ClientSpawner } from "posipaki/remote";
import { podmanEntry } from "./commands.js";
import { runHost } from "./host.js";
import type { HostResult, HostRun, SpawnChild } from "./host.js";
import { spawnChild as startOnHost } from "./host.js";
import { PodmanSpecError } from "./spec.js";

/** What a prepare step is handed: the container, and a way to run something in it. */
export interface PodmanPrepare {
  container: string;
  /** Run a command inside the container and wait for what it said. */
  run(command: string[], stdin?: string): Promise<HostResult>;
}

/** A way into a container that somebody else keeps alive. */
export interface PodmanConnectSpec<Args, Prepared = void> {
  /** The container to enter.  Required: this runs actors in containers, it does not find them. */
  container: string;
  /** Runs once before the actor.  Optional: what is already in the image needs nothing. */
  prepare?: (ctx: PodmanPrepare) => Promise<Prepared>;
  /** The actor's argv inside the container, given what prepare left behind. */
  command: (args: Args, prepared: Prepared) => string[];
}

/** How the container's process is started and watched — everything but what runs in it. */
export interface PodmanConnectOptions {
  /** Where the container's own output goes.  Defaults to our stderr, tagged with its name. */
  onOutput?: OutputSink;
  /** How long to wait for the container's first protocol frame. */
  handshakeTimeoutMs?: number;
  /** Called when the container's process is gone, whichever way it went. */
  onGone?: () => void;
  /** How host commands run.  Injectable. */
  runHost?: HostRun;
  /** How the container's process is started.  Injectable, so a test can hold the process. */
  spawnChild?: SpawnChild;
}

/** How much of what a failed container said we quote as the reason. */
const REASON_TAIL = 400;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start the run command and hand its own stdin/stdout to the wire.  A container
 * that dies before it speaks fails the spawn with what it said, rather than a
 * channel that never answers.
 */
async function openChannel(
  container: string,
  command: string[],
  options: PodmanConnectOptions,
): Promise<Channel> {
  const sink = options.onOutput ?? stderrSink(container);
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
  // podman itself speaks — "no such container", "the exec failed" — so it goes to
  // the sink, and the tail of it becomes the reason a container that dies early
  // is reported with.
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => output(2, chunk));

  const exited = new Promise<never>((_, reject) => {
    // `close`, not `exit`: the process being gone is not the same as everything it
    // said having arrived, and the tail of its stderr is the whole reason here.
    child.once("close", (code, signal) => {
      const how = signal === null ? `code ${code}` : `signal ${signal}`;
      const why = tail.trim();
      reject(new Error(`the container exited with ${how}${why ? `: ${why}` : ""}`));
    });
    child.once("error", (err) => reject(new Error(`cannot start the container: ${err.message}`)));
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
    throw new PodmanSpecError(`container ${container} is not available: ${errorText(err)}`);
  }

  // The run's own exit is the channel's close: whichever side goes first, the
  // other stops waiting — and the caller is told, because its slot must stop
  // pointing at a process that is gone.
  child.once("exit", () => {
    options.onGone?.();
    void channel.close().catch(() => {});
  });
  return channel;
}

/**
 * The connector: the container is there, the actor is prepared if it has to be,
 * and it runs on the exec's own stdin/stdout.  Nothing here starts or stops a
 * container — a name with no container behind it fails, and says so.
 */
export function podmanConnector<Args, Prepared = void>(
  spec: PodmanConnectSpec<Args, Prepared>,
  options: PodmanConnectOptions = {},
): ClientSpawner<Args> {
  const run = options.runHost ?? runHost;
  return async (args: Args): Promise<Channel> => {
    const prepared = spec.prepare
      ? await spec.prepare({
          container: spec.container,
          run: (command, stdin = "") => run(command, stdin),
        })
      : (undefined as Prepared);
    return openChannel(spec.container, podmanEntry(spec.container, spec.command(args, prepared)), options);
  };
}
