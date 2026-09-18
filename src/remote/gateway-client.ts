// ── The client side of the gateway ─────────────────────────────────────────
//
// A consumer has two things: a payload, and the build its bytes came from.  A way in has
// one: how to run a command somewhere else.  Everything else is the same whatever the way
// in is, and this module is that everything else:
//
//   1. the gateway script is posipaki's own entry (`posipaki/remote/gateway-cli.js`, a
//      published specifier, so it is resolved where the kit is staged from) — or the
//      consumer's, for a program that carries its own;
//   2. both bundles go into one kit, whose directory name *is* the host version it serves —
//      the app, the build those bytes came from, the posipaki release that speaks to them —
//      so a second run of the same build finds the kit already there and copies nothing;
//   3. whatever has to be *copied* there is staged through the way in's own channel — the
//      core's bootstrap script, one report line per step — which is also where the runtime
//      that will run it is found, so a way in never has to know what a `node` is.  A
//      program the caller says is already installed is not staged at all, and then no
//      command of ours runs in the environment beyond the two that matter;
//   4. the gateway runs there — `<runtime> <kit>/gateway.js` when it was staged, the caller's
//      own command when it was not — its stdin/stdout are the wire, and it makes the fifos
//      inside the environment and starts the payload against them.  The payload is run this
//      way in *every* way in, which is why the payload is only ever a fifo worker.  The
//      payload's own command and the host version are arguments the gateway carries without
//      knowing which is which: staged artifacts are ours, and the payload checks itself
//      against what it was asked for.
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
  hostVersion,
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

/**
 * A program the way in starts there: a bundle of ours to copy into the environment, or a
 * command that already runs there — an absolute path, a name on `$PATH`, a runtime and a
 * script of its own.  Which of the two it is, is the caller's decision, and it is the only
 * thing posipaki needs to know about where the far end comes from.
 */
export type HostProgram = { stage: string } | { run: string[] };

/** Everything a client needs: where the two programs are, whose payload it is, and the way in. */
export interface RemoteSpec<Args> extends RemoteWayIn {
  /** The payload: ours to stage there, or the one already installed there. */
  payload: HostProgram;
  /**
   * Whose payload this is: the app name and the build those bytes came from.  Required
   * whenever anything is staged — a kit's directory *is* the host version — and stated to the
   * payload whenever it is given at all, which is the one fact a caller can hand an installed
   * payload about the build it is expected to be.  Omitted, nothing is stated and nothing is
   * checked, which is only right for a payload whose bytes carry no version of their own.
   */
  hostVersion?: KitApp;
  /** The gateway: posipaki's own bundle, staged, unless the caller says otherwise. */
  gateway?: HostProgram;
  /** Runtime candidates on the far side, best first.  Defaults to `DEFAULT_RUNTIMES`. */
  runtime?: string[];
  /** Where the kit lands there, relative to its `$HOME`.  Defaults to `DEFAULT_KIT_PARENT`. */
  parent?: string;
  /**
   * The payload's own arguments, built from the args the actor was spawned with.  The gateway
   * carries them to the payload untouched — it does not know what they mean, and does not need
   * to: what a consumer tells its own far end is the consumer's business.
   */
  payloadArgs?: (args: Args) => string[];
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

/** The argv that starts each of the two programs there. */
interface Programs {
  gateway: string[];
  payload: string[];
}

function isStage(program: HostProgram): program is { stage: string } {
  return "stage" in program;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * posipaki's own gateway program, resolved where the consumer installed it — the default for
 * a caller that has none of its own to deploy.
 */
function gatewayEntry(): string {
  try {
    return fileURLToPath(import.meta.resolve(GATEWAY_ENTRY));
  } catch (err) {
    throw new RemoteSpecError(
      `cannot find posipaki's gateway program (${GATEWAY_ENTRY}): ${errorText(err)}.  ` +
        "Stage one with `gateway:` — a consumer whose program carries its own.",
    );
  }
}

/** The kit's files: what has to be copied there, under the names the script writes them as. */
async function kitFiles(
  gateway: HostProgram,
  payload: HostProgram,
): Promise<{ name: string; content: Buffer }[]> {
  const files: { name: string; content: Buffer }[] = [];
  if (isStage(payload)) files.push({ name: PAYLOAD_ARTIFACT, content: await readFile(payload.stage) });
  if (isStage(gateway)) files.push({ name: GATEWAY_ARTIFACT, content: await readFile(gateway.stage) });
  return files;
}

/** A command with nothing to run is a spec that says nothing; refuse it before spawning it. */
function programCommand(program: { run: string[] }, what: string, name: string): string[] {
  if (program.run.length === 0 || program.run[0] === undefined || program.run[0] === "") {
    throw new RemoteSpecError(`${name}: ${what} is a command with nothing to run`);
  }
  return program.run;
}

/**
 * The two commands, staging whatever has to be copied there first.
 *
 * Nothing staged means no command of ours runs in the environment at all: the caller's own
 * argv is handed through as it stands, which is the case for a program that is already
 * installed.  Something staged needs a host version to name the kit with — and a kit's
 * directory *is* the host version, so there is nothing to guess at.
 */
async function programsFor(spec: Spec, run: HostRun): Promise<Programs> {
  const gateway: HostProgram = spec.gateway ?? { stage: gatewayEntry() };
  const payload = spec.payload;
  if (!isStage(gateway) && !isStage(payload)) {
    return {
      gateway: programCommand(gateway, "the gateway", spec.name),
      payload: programCommand(payload, "the payload", spec.name),
    };
  }
  if (spec.hostVersion === undefined) {
    throw new RemoteSpecError(
      `nothing names the kit to stage into ${spec.name}: state hostVersion — a kit's directory ` +
        "is the host version, and a payload refuses to serve one its own bytes do not carry",
    );
  }
  const kit = makeKit(await kitFiles(gateway, payload), {
    app: spec.hostVersion,
    runtimes: spec.runtime ?? DEFAULT_RUNTIMES,
    parent: spec.parent ?? DEFAULT_KIT_PARENT,
  });
  const staged = await stageKit(spec, kit, run);
  const at = (artifact: string) => [staged.runtime, `${staged.kitDir}/${artifact}`];
  return {
    gateway: isStage(gateway) ? at(GATEWAY_ARTIFACT) : gateway.run,
    payload: isStage(payload) ? at(PAYLOAD_ARTIFACT) : payload.run,
  };
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
async function stageKit(spec: Spec, kit: Kit, run: HostRun): Promise<{ kitDir: string; runtime: string }> {
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
 * A spawner for an actor that lives behind a gateway in some environment: put the payload and
 * posipaki's gateway wherever they belong, run the gateway, speak the client side.
 */
export function gatewayClient<Args>(spec: RemoteSpec<Args>): ClientSpawner<Args> {
  const run: HostRun = spec.run ?? runHost;
  const spawn: SpawnChild = spec.spawn ?? spawnChild;
  return async (args: Args): Promise<Channel> => {
    // The spec is read before a command runs on its behalf: a payload that is not there
    // should fail here, not as an environment that cannot be reached.
    const programs = await programsFor(spec, run);
    const command = [
      ...programs.gateway,
      ...gatewayArgs({
        // What the payload is started as, then posipaki's own facts among the caller's
        // arguments: the host version, and whatever the consumer adds for its own far end.
        // Which of these is whose is not the gateway's business — it starts what it is handed
        // and carries the rest.
        passthrough: [
          ...programs.payload.slice(1),
          ...(spec.hostVersion === undefined
            ? []
            : [`--host-version=${hostVersion(spec.hostVersion)}`]),
          ...(spec.payloadArgs?.(args) ?? []),
        ],
        worker: programs.payload[0]!,
      }),
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
