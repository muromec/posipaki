// ── Running an actor in a sandbox that is ours to make ─────────────────────
//
// The connector knows one thing: how to open a channel into a sandbox and run
// something in it.  It does not create anything beforehand or clean anything up
// afterwards — bwrap makes the sandbox for as long as the command runs, so there
// is nothing to hold and nothing to remove.  What it is, is the policy plus a
// command.
//
// Two knobs, and they are the whole way in:
//
//   prepare   optional — runs once before the actor, in the sandbox, for an actor
//             that has to be put there first (see stage.ts for the staging);
//   command   what to run, as an argv, given what prepare left behind.

import type { ChildProcess, StdioOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { clientChannel, stderrSink } from "posipaki/remote/node";
import type { LineStreams, OutputFd, OutputSink } from "posipaki/remote/node";
import type { Channel, ClientSpawner } from "posipaki/remote";
import { bwrapEntry } from "./commands.js";
import { runHost } from "./host.js";
import type { HostResult, HostRun, SpawnChild } from "./host.js";
import { spawnChild as startOnHost } from "./host.js";
import { BwrapSpecError } from "./spec.js";
import type { SandboxSpec } from "./spec.js";

/** What a prepare step is handed: the sandbox, and a way to run something in it. */
export interface BwrapPrepare {
  sandbox: string;
  /** Run a command in the sandbox and wait for what it said. */
  run(command: string[], stdin?: string): Promise<HostResult>;
}

/** A way into a sandbox built from a policy. */
export interface BwrapConnectSpec<Args, Prepared = void> {
  /** The sandbox: its name, and the bwrap arguments that shape it.  Required — this runs actors in sandboxes, it does not guess what they may touch. */
  sandbox: SandboxSpec;
  /** Runs once before the actor.  Optional: what is already on the machine needs nothing. */
  prepare?: (ctx: BwrapPrepare) => Promise<Prepared>;
  /** The actor's argv inside the sandbox, given what prepare left behind. */
  command: (args: Args, prepared: Prepared) => string[];
}

/** How the sandbox's process is started and watched — everything but what runs in it. */
export interface BwrapConnectOptions {
  /** Where the sandbox's own output goes.  Defaults to our stderr, tagged with its name. */
  onOutput?: OutputSink;
  /** How long to wait for the sandbox's first protocol frame. */
  handshakeTimeoutMs?: number;
  /** Called when the sandbox's process is gone, whichever way it went. */
  onGone?: () => void;
  /** How host commands run.  Injectable, so tests need no sandbox. */
  runHost?: HostRun;
  /** How the sandbox's process is started.  Injectable, so a test can hold the process. */
  spawnChild?: SpawnChild;
}

/** How much of what a failed sandbox said we quote as the reason. */
const REASON_TAIL = 400;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start the run command and hand its own stdin/stdout to the wire.  A sandbox
 * that dies before it speaks — bwrap not installed, a bind that is not there,
 * a payload that cannot be run — fails the spawn with what it said, rather than a
 * channel that never answers.
 */
async function openChannel(
  sandbox: string,
  command: string[],
  options: BwrapConnectOptions,
): Promise<Channel> {
  const sink = options.onOutput ?? stderrSink(sandbox);
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
  // bwrap itself speaks — "bwrap: Can't find source path", "execvp: No such file
  // or directory" — so it goes to the sink, and the tail of it becomes the reason
  // a sandbox that dies early is reported with.
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => output(2, chunk));

  const exited = new Promise<never>((_, reject) => {
    // `close`, not `exit`: the process being gone is not the same as everything it
    // said having arrived, and the tail of its stderr is the whole reason here.
    child.once("close", (code, signal) => {
      const how = signal === null ? `code ${code}` : `signal ${signal}`;
      const why = tail.trim();
      reject(new Error(`the sandbox exited with ${how}${why ? `: ${why}` : ""}`));
    });
    child.once("error", (err) => reject(new Error(`cannot start the sandbox: ${err.message}`)));
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
    throw new BwrapSpecError(`sandbox ${sandbox} is not available: ${errorText(err)}`);
  }

  // The sandbox's own exit is the channel's close: whichever side goes first, the
  // other stops waiting — and the caller is told, because its slot must stop
  // pointing at a process that is gone.
  child.once("exit", () => {
    options.onGone?.();
    void channel.close().catch(() => {});
  });
  return channel;
}

/**
 * The connector: the policy is handed to bwrap, the actor is prepared if it has to
 * be, and it runs on the run's own stdin/stdout.  Nothing here is created ahead of
 * the command or left behind after it — a policy bwrap cannot apply fails, and
 * says so.
 */
export function bwrapConnector<Args, Prepared = void>(
  spec: BwrapConnectSpec<Args, Prepared>,
  options: BwrapConnectOptions = {},
): ClientSpawner<Args> {
  const run = options.runHost ?? runHost;
  return async (args: Args): Promise<Channel> => {
    const prepared = spec.prepare
      ? await spec.prepare({
          sandbox: spec.sandbox.name,
          run: (command, stdin = "") => run(command, stdin),
        })
      : (undefined as Prepared);
    return openChannel(
      spec.sandbox.name,
      bwrapEntry(spec.sandbox, spec.command(args, prepared)),
      options,
    );
  };
}
