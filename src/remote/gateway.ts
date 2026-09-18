// ── Gateway ────────────────────────────────────────────────────────────────
//
// The first-stage command.  Run this *inside* a foreign environment — directly,
// under `sudo`, over ssh, in a container — and it:
//
//   1. creates the channel to the payload (fifo paths it makes itself, in a
//      private temp dir, so they belong to the uid that will open them),
//   2. starts the payload — the first argument, required — and relays frames
//      between stdin/stdout,
//   3. carries whatever the payload prints to the client as output frames
//      (`$fd`), so the payload's own stdout can never be mistaken for protocol.
//
// Why a gateway at all: a fifo path created on the client side is useless when the
// payload runs as another uid (it cannot open it) or on another host (the path is
// not there).  stdio is the one channel every way into an environment gives us, so
// the wire is stdio and the fifo stays inside the environment.
//
// Directories and processes are cleaned up on every exit path, which is also why
// the client never sees a transport being closed twice.
//
// It imports nothing but node builtins and this package, so the payload behind it
// can be anything the runtime there can start.

import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { KitApp } from "./kit.js";
import { hostVersion, parseHostVersion, versionLine } from "./kit.js";
import { VERSION } from "./protocols/json1.js";
import { errorFrame, outputFrame } from "./stdio.js";
import type { LineTransport, OutputFd } from "./stdio.js";
import { LineTransport as Lines } from "./stdio.js";
import { FifoUtf8NlineTransport } from "./transports/fifo.js";

const run = promisify(execFile);

/** Exit code for "this environment could not be set up". */
export const GATEWAY_FAILED = 1;

export interface GatewayBoot {
  /** Who staged this payload.  Names the artifact in its `--version` line. */
  app: KitApp;
  /** A label for logs, the tree name and the payload's own `--env`; `unnamed` when nobody said. */
  env?: string;
  /** Forwarded to the payload when given. */
  poolSize?: number;
  /** The payload to relay to.  Required, and first — the gateway has no opinion of its own. */
  worker: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function flagValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/** A `--flag=<positive integer>` argument, or undefined. */
function positiveInt(value: string | undefined): number | undefined {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

/**
 * The argv that boots this gateway — built by the client, read by
 * {@link gatewayBoot}, so the two halves cannot drift apart.
 *
 * The payload comes first and the flags after it: what the consumer's own `args` add
 * follows, so a positional argument of the payload's own can never be mistaken for the
 * payload.
 */
export function gatewayArgs(boot: GatewayBoot): string[] {
  return [
    boot.worker,
    `--host-version=${hostVersion(boot.app)}`,
    ...(boot.env === undefined ? [] : [`--env=${boot.env}`]),
    ...(boot.poolSize === undefined ? [] : [`--pool-size=${boot.poolSize}`]),
  ];
}

/** The boot a gateway was started with, or the reason it cannot start. */
export function gatewayBoot(argv: string[]): GatewayBoot {
  const worker = argv[0];
  if (worker === undefined || worker.startsWith("--")) {
    throw new Error("no <payload>: the gateway relays to a payload, named as its first argument");
  }
  const host = flagValue(argv, "host-version");
  const app = host === undefined ? undefined : parseHostVersion(host);
  if (app === undefined) {
    throw new Error(
      "no --host-version=<app>@<version>: the gateway says whose payload it relays",
    );
  }
  return {
    app,
    ...(flagValue(argv, "env") === undefined ? {} : { env: flagValue(argv, "env")! }),
    poolSize: positiveInt(flagValue(argv, "pool-size")),
    worker,
  };
}

/**
 * End a start that failed.  The reason has already gone out on the wire, and
 * returning is not enough: the `open()` on a fifo no payload will ever write sits
 * in the threadpool forever, so the loop never drains and the gateway would linger
 * with a dead payload on its books.
 */
function abandon(): never {
  process.exit(GATEWAY_FAILED);
}

/** Carry a failed start to the client, then let the caller exit non-zero. */
async function fail(wire: LineTransport, reason: string): Promise<void> {
  process.stderr.write(`gateway: ${reason}\n`);
  try {
    await wire.send(errorFrame(reason));
  } catch {
    /* the client is gone too — the exit code still says what happened */
  }
}

/** Copy everything the payload prints onto the wire as output frames. */
function forwardOutput(stream: NodeJS.ReadableStream, wire: LineTransport, fd: OutputFd): void {
  stream.setEncoding("utf-8");
  stream.on("data", (chunk: string) => {
    void wire.send(outputFrame(fd, chunk)).catch(() => {
      /* the client hung up: the payload's exit is what matters now */
    });
  });
}

/**
 * Serve one environment over stdin/stdout.  Returns the exit code; the caller
 * turns it into `process.exitCode`.
 */
export async function runGateway(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--version")) {
    const host = flagValue(argv, "host-version");
    const app = (host === undefined ? undefined : parseHostVersion(host)) ?? {
      name: "posipaki",
      version: "-",
    };
    process.stdout.write(`${versionLine(app, "gateway", VERSION)}\n`);
    return 0;
  }
  const wire = new Lines({ read: process.stdin, write: process.stdout });

  let booted: GatewayBoot;
  try {
    booted = gatewayBoot(argv);
  } catch (err) {
    // Nothing has been started yet, so there is nothing to tear down — but the
    // client still deserves the reason rather than a channel that closes on it,
    // and the loop can outlive us: an open stdin nobody will close keeps the
    // process alive, so this is an exit, not a return.
    await fail(wire, errorText(err));
    abandon();
  }
  const { env = "unnamed", poolSize, worker } = booted;

  const dir = await mkdtemp(join(tmpdir(), `posipaki-${env.replace(/\//g, "-")}-`));
  const fifoIn = join(dir, "in"); // the payload writes, we read
  const fifoOut = join(dir, "out"); // we write, the payload reads

  let child: ChildProcess | null = null;
  let fifo: FifoUtf8NlineTransport | null = null;

  /**
   * Everything this gateway owns, undone.  All of it is idempotent, because the
   * exit path and the signal path can both arrive.
   */
  const teardown = async (): Promise<void> => {
    child?.kill();
    await fifo?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  /**
   * A client that gives up stops us with a signal, and a gateway that died on the
   * spot would leave its payload behind in the environment — a process holding a
   * fifo nobody will ever write, which is a leak the environment cannot clean up
   * for us.  So the signals do what the exit path does.
   */
  const onTerminate = () => {
    void teardown()
      .catch(() => {})
      .then(() => process.exit(GATEWAY_FAILED));
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, onTerminate);

  try {
    await run("mkfifo", ["-m", "600", fifoIn, fifoOut]);
  } catch (err) {
    await fail(wire, `cannot create the environment's fifos: ${errorText(err)}`);
    await teardown();
    abandon();
  }

  // Open the read side in the background, then start the payload that unblocks
  // it — the order the fifo handshake requires.
  const connection = FifoUtf8NlineTransport.beginConnect(fifoIn, fifoOut);
  const workerArgs = [
    worker,
    `--env=${env}`,
    ...(poolSize === undefined ? [] : [`--pool-size=${poolSize}`]),
    `--fifo-in=${fifoIn}`,
    `--fifo-out=${fifoOut}`,
  ];
  const workerProc = spawn(process.execPath, workerArgs, { stdio: ["ignore", "pipe", "pipe"] });
  child = workerProc;
  forwardOutput(workerProc.stdout, wire, 1);
  forwardOutput(workerProc.stderr, wire, 2);

  const exited = new Promise<number>((settle) => {
    // A payload killed by a signal (the client hung up, and we killed it) has no
    // code — for us that is a clean end, not a failure.
    workerProc.once("exit", (code) => settle(code ?? 0));
  });

  try {
    fifo = await Promise.race([
      connection.transport,
      exited.then((code) => {
        throw new Error(`the payload exited with code ${code} before it opened its channel`);
      }),
    ]);
  } catch (err) {
    await fail(wire, errorText(err));
    await teardown();
    abandon();
  }

  // Relay: the protocol is the client's and the payload's business, not ours.
  const relay = fifo;
  relay.onMessage((line) => {
    void wire.send(line).catch(() => {
      /* client gone */
    });
  });
  wire.onMessage((line) => {
    void relay.send(line).catch(() => {
      /* the payload is gone; its exit path cleans up */
    });
  });
  wire.onClose(() => {
    child?.kill();
  });

  const code = await exited;
  await teardown();
  await wire.close();
  return code;
}
