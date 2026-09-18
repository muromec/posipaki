// ── The client side of the gateway ─────────────────────────────────────────
//
// A consumer has two things: a payload bundle on this machine, and the build its bytes
// came from.  A way in has one: how to run a command somewhere else.  Everything else is
// the same whatever the way in is, and this module is that everything else:
//
//   1. the gateway script is posipaki's own entry (`posipaki/remote/gateway-cli.js`, a
//      published specifier, so it is resolved where the kit is staged from) — or the
//      consumer's, for a program that carries its own;
//   2. both bundles go into one kit, named after the app, the build and the posipaki it
//      speaks (`kitName`), so a second run of the same build finds the kit already
//      there and copies nothing;
//   3. the kit is staged through the way in's own channel — the core's bootstrap script,
//      one report line per step — which is also where the runtime that will run it is
//      found, so a way in never has to know what a `node` is;
//   4. `<runtime> <kit>/gateway.js <kit>/payload.js --host-version=<app>@<version>` runs
//      there, its stdin/stdout are the wire, and the gateway makes the fifos inside the
//      environment.  The payload is run this way in *every* way in, which is why the
//      payload is only ever a fifo worker.
//
// What a way in supplies is `entry`: the argv that runs a command there.  It is the whole
// difference between bwrap, ssh, a container and this machine, and it is one function.

import type { ChildProcess, StdioOptions } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Channel } from "./channel.js";
import type { ClientSpawner } from "./client.js";
import { gatewayArgs } from "./gateway.js";
import { runHost, spawnChild } from "./host.js";
import type { HostResult, HostRun, SpawnChild } from "./host.js";
import {
  DEFAULT_KIT_PARENT,
  DEFAULT_RUNTIMES,
  GATEWAY_ARTIFACT,
  PAYLOAD_ARTIFACT,
  bootstrapScript,
  makeKit,
  parseBootstrapReport,
} from "./kit.js";
import type { Kit, KitApp } from "./kit.js";
import { clientChannel, stderrSink } from "./stdio.js";
import type { LineStreams, OutputFd, OutputSink } from "./stdio.js";

/** posipaki's own gateway program.  A consumer with one of its own stages that instead. */
export const GATEWAY_ENTRY = "posipaki/remote/gateway-cli.js";

/** How much of what a failed staging command said is quoted back as part of the reason. */
const SAID_TAIL = 400;

/** How much of the far end's stderr is kept, to be the reason a start failed. */
const REASON_TAIL = 400;

/** Staging failed, or the far end never spoke: the caller's spec, or the environment's answer. */
export class RemoteSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteSpecError";
  }
}

/** What a way in is handed, and how it runs what it is handed. */
export interface RemoteWayIn {
  /** What the far end's output and errors are tagged with. */
  name: string;
  /** The argv that runs `command` there: bwrap's policy, ssh's host, podman's container. */
  entry: (command: string[]) => string[];
  /** How a plain command runs there and is waited for.  Injectable, so a test needs no way in. */
  run?: HostRun;
  /** How the wire's process is started there.  Injectable likewise. */
  spawn?: SpawnChild;
}

/** Everything a client needs: where the payload is, whose it is, and the way in. */
export interface RemoteSpec<Args> extends RemoteWayIn {
  /** The payload bundle on this machine, as the consumer built it. */
  payload: string;
  /** Whose payload it is: the app name, and the build those bytes came from. */
  host: KitApp;
  /** The gateway bundle to stage; defaults to {@link GATEWAY_ENTRY}, resolved by us. */
  gateway?: string;
  /** Runtime candidates on the far side, best first.  Defaults to `DEFAULT_RUNTIMES`. */
  runtime?: string[];
  /** Where the kit lands there, relative to its `$HOME`.  Defaults to `DEFAULT_KIT_PARENT`. */
  parent?: string;
  /** The payload's own arguments, built from the args the actor was spawned with. */
  payloadArgs?: (args: Args, staged: RemoteStaged) => string[];
  /** Where the far end's own output goes.  Defaults to our stderr, tagged with `name`. */
  onOutput?: OutputSink;
  /** How long to wait for the far end's first protocol frame. */
  handshakeTimeoutMs?: number;
  /** Called when the far end's process is gone, whichever way it went. */
  onGone?: () => void;
}

/**
 * The part of a spec the machinery here reads, with the actor's own arguments left out:
 * staging, the channel and the argv are the same whatever an actor is told.
 */
type Spec = Omit<RemoteSpec<unknown>, "payloadArgs">;

/** What staging left behind: where the kit is, and what will run it. */
export interface RemoteStaged {
  kitDir: string;
  runtime: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The gateway program to stage: the consumer's, or posipaki's own published entry. */
function gatewayProgram(spec: Spec): string {
  if (spec.gateway !== undefined) return spec.gateway;
  try {
    return fileURLToPath(import.meta.resolve(GATEWAY_ENTRY));
  } catch (err) {
    throw new RemoteSpecError(
      `cannot find posipaki's gateway program (${GATEWAY_ENTRY}): ${errorText(err)}.  ` +
        "Stage one with `gateway:` — a consumer whose program carries its own.",
    );
  }
}

/** The kit this spec ships: the payload and the gateway, under the names the script writes. */
async function kitFor(spec: Spec): Promise<Kit> {
  const gateway = gatewayProgram(spec);
  const files = [
    { name: PAYLOAD_ARTIFACT, content: await readFile(spec.payload) },
    { name: GATEWAY_ARTIFACT, content: await readFile(gateway) },
  ];
  return makeKit(files, {
    app: spec.host,
    runtimes: spec.runtime ?? DEFAULT_RUNTIMES,
    parent: spec.parent ?? DEFAULT_KIT_PARENT,
  });
}

/** The tail of what a command said, for a failure that has no better story. */
function said(result: HostResult): string {
  const text = `${result.stderr}${result.stdout}`.trim();
  const tail = text.length > SAID_TAIL ? text.slice(-SAID_TAIL) : text;
  return tail === "" ? `exit code ${result.code}` : tail;
}

/**
 * Put the kit where the environment can see it and say what will run it.  Idempotent:
 * the script probes, writes only what is missing and reports — so a spawn of a build
 * that is already staged costs one process and no writes.
 */
async function stageKit(spec: Spec, kit: Kit, run: HostRun): Promise<RemoteStaged> {
  const result = await run(spec.entry(["sh", "-s"]), bootstrapScript(kit));
  const report = parseBootstrapReport(result.stdout);
  if (report.kind === "error") {
    // A report that never arrived is not a reason; what the environment said is.
    const incomplete =
      report.reason.startsWith("incomplete") || report.reason.startsWith("no report");
    throw new RemoteSpecError(
      `staging into ${spec.name} failed: ${report.reason}${incomplete ? ` (${said(result)})` : ""}`,
    );
  }
  return { kitDir: report.kitDir, runtime: report.runtime };
}

/**
 * Start the run command and hand its own stdin/stdout to the wire.  An environment that
 * dies before it speaks — bwrap not installed, a host that refuses, a payload that
 * cannot be run — fails the spawn with what it said, rather than a channel that never
 * answers.
 */
async function openChannel(
  spec: Spec,
  command: string[],
  spawn: SpawnChild,
): Promise<Channel> {
  const sink = spec.onOutput ?? stderrSink(spec.name);
  let tail = "";
  const output: OutputSink = (fd: OutputFd, data: string) => {
    if (fd === 2) tail = (tail + data).slice(-REASON_TAIL);
    sink(fd, data);
  };

  // The run's own stdin and stdout *are* the wire, so both have to be pipes.
  const stdio: StdioOptions = ["pipe", "pipe", "pipe"];
  const child: ChildProcess = spawn(command, stdio);
  const streams: LineStreams = { read: child.stdout as Readable, write: child.stdin as Writable };

  // The run's stdin and stdout are the wire; its stderr is not.  That is where the way
  // in itself speaks — "bwrap: Can't find source path", "Permission denied" — so it goes
  // to the sink, and the tail of it becomes the reason a start that died is reported with.
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => output(2, chunk));

  const exited = new Promise<never>((_, reject) => {
    // `close`, not `exit`: the process being gone is not the same as everything it said
    // having arrived, and the tail of its stderr is the whole reason here.
    child.once("close", (code, signal) => {
      const how = signal === null ? `code ${code}` : `signal ${signal}`;
      const why = tail.trim();
      reject(new Error(`exited with ${how}${why ? `: ${why}` : ""}`));
    });
    child.once("error", (err) => reject(new Error(`cannot start: ${err.message}`)));
  });
  // A spawn that resolves leaves this rejection unobserved — fine, as long as it is not
  // reported as an unhandled rejection.
  exited.catch(() => {});

  let channel: Channel;
  try {
    channel = await Promise.race([
      clientChannel(streams, {
        onOutput: output,
        ...(spec.handshakeTimeoutMs === undefined ? {} : { timeoutMs: spec.handshakeTimeoutMs }),
      }),
      exited,
    ]);
  } catch (err) {
    child.kill();
    throw new RemoteSpecError(`${spec.name} is not available: ${errorText(err)}`);
  }

  // The far end's exit is the channel's close: whichever side goes first, the other stops
  // waiting — and the caller is told, because its slot must stop pointing at a process
  // that is gone.
  child.once("exit", () => {
    spec.onGone?.();
    void channel.close().catch(() => {});
  });
  return channel;
}

/**
 * A spawner for an actor that lives behind a gateway in some environment: stage the
 * payload and posipaki's gateway there, run the gateway, speak the client side.
 */
export function gatewayClient<Args>(spec: RemoteSpec<Args>): ClientSpawner<Args> {
  const run: HostRun = spec.run ?? runHost;
  const spawn: SpawnChild = spec.spawn ?? spawnChild;
  return async (args: Args): Promise<Channel> => {
    // The spec is read before a command runs on its behalf: a payload that is not there
    // should fail here, not as an environment that cannot be reached.
    const kit = await kitFor(spec);
    const staged = await stageKit(spec, kit, run);
    const own = spec.payloadArgs?.(args, staged) ?? [];
    const command = [
      staged.runtime,
      `${staged.kitDir}/${GATEWAY_ARTIFACT}`,
      ...gatewayArgs({ app: spec.host, worker: `${staged.kitDir}/${PAYLOAD_ARTIFACT}` }),
      ...own,
    ];
    return openChannel(spec, spec.entry(command), spawn);
  };
}

/**
 * The way in where the environment is this machine: nothing wraps the command, and the
 * kit is staged under `$HOME` like any other.  Everything below the entry is the same as
 * for a sandbox, a host or a container — which is the point of it being here.
 */
export function hostRemote<Args>(
  spec: Omit<RemoteSpec<Args>, "name" | "entry"> & { name?: string },
): ClientSpawner<Args> {
  return gatewayClient({ name: "this host", entry: (command) => command, ...spec });
}
