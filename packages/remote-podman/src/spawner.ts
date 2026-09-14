// ── The way in as a spawner ────────────────────────────────────────────────
//
// A spawner is what the remote seam asks for: hand it the args the client was
// spawned with, and it returns a channel.  Here that is: the container is there
// (or started and held), the kit goes in over one `exec`, and the actor speaks
// over a second one — while the container's own output stays out of the protocol.

import type { ChildProcess, StdioOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { clientChannel, stderrSink } from "posipaki/remote/node";
import type { LineStreams, OutputFd, OutputSink } from "posipaki/remote/node";
import type { Channel, ClientSpawner } from "posipaki/remote";
import { podmanRunCommand } from "./commands.js";
import { spawnChild as startOnHost } from "./host.js";
import type { SpawnChild } from "./host.js";
import type { PodmanLifetimeOptions } from "./lifetime.js";
import { PodmanSpecError } from "./spec.js";
import type { PodmanSpec, PodmanStaged } from "./spec.js";
import { podmanStage } from "./stage.js";

/** How the container's process is started and watched — everything but what runs in it. */
export interface PodmanWireOptions {
  /** Where the container's own output goes.  Defaults to our stderr, tagged with its name. */
  onOutput?: OutputSink;
  /** How long to wait for the container's first protocol frame. */
  handshakeTimeoutMs?: number;
  /** Called when the container's process is gone, whichever way it went. */
  onGone?: () => void;
  /** How the container's process is started.  Injectable, so a test can hold the process. */
  spawnChild?: SpawnChild;
}

export interface PodmanSpawnerOptions<Args>
  extends PodmanLifetimeOptions,
    PodmanWireOptions {
  /**
   * The payload's own arguments, built from the args the client was spawned with.
   * This package knows where the payload is and how it is started, not what it
   * wants to be told.
   */
  args?: (args: Args, staged: PodmanStaged) => string[];
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
  spec: PodmanSpec,
  command: string[],
  options: PodmanWireOptions,
): Promise<Channel> {
  const name = spec.container;
  const sink = options.onOutput ?? stderrSink(name);
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
    throw new PodmanSpecError(`container ${name} is not available: ${errorText(err)}`);
  }

  // The container's own exit is the channel's close: whichever side goes first,
  // the other stops waiting — and the caller is told, because its slot must stop
  // pointing at a process that is gone.
  child.once("exit", () => {
    options.onGone?.();
    void channel.close().catch(() => {});
  });
  return channel;
}

/**
 * The podman way in: the container is there or started, the kit is staged into it
 * over one `exec`, and the actor runs over a second one.  Every spawn stages — the
 * far side probes first, so a kit that is already there is not written again.
 */
export function podmanSpawner<Args>(
  spec: PodmanSpec,
  options: PodmanSpawnerOptions<Args> = {},
): ClientSpawner<Args> {
  return async (args: Args): Promise<Channel> => {
    const staged = await podmanStage(spec, options);
    const argv = podmanRunCommand(spec, staged, options.args?.(args, staged) ?? []);
    return openChannel(spec, argv, options);
  };
}
