// ── Gateway ────────────────────────────────────────────────────────────────
//
// The first-stage command.  Run this *inside* a foreign environment — directly,
// under `sudo`, over ssh, in a container — and it:
//
//   1. creates the channel to the payload (fifo paths it makes itself, in a
//      private temp dir, so they belong to the uid that will open them),
//   2. starts the payload — the first argument, required — hands it the host version it was
//      asked for (`--host-version`), and relays frames between stdin/stdout,
//   3. carries whatever the payload prints to the client as output frames
//      (`$fd`), so the payload's own stdout can never be mistaken for protocol.
//
// Why a gateway at all: a fifo path created on the client side is useless when the
// payload runs as another uid (it cannot open it) or on another host (the path is
// not there).  stdio is the one channel every way into an environment gives us, so
// the wire is stdio and the fifo stays inside the environment.
//
// The gateway reads nothing out of what it carries: the payload's path and its host version go
// through verbatim, and the payload is the one who refuses a version it is not.  A relay that
// judged would be a second place for the same decision.
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
import { errorFrame, outputFrame } from "./stdio.js";
import type { LineTransport, OutputFd } from "./stdio.js";
import { LineTransport as Lines } from "./stdio.js";
import { FifoUtf8NlineTransport } from "./transports/fifo.js";

const run = promisify(execFile);

/** Exit code for "this environment could not be set up". */
export const GATEWAY_FAILED = 1;

export interface GatewayBoot {
  /**
   * The host version this payload is being started for, carried **verbatim** to the payload and
   * never read here: the gateway relays, and the artifact that can be stale is the payload.
   * Absent when the caller states none — which is only right for a payload that knows no
   * version of its own.
   */
  hostVersion?: string;
  /** The payload to relay to.  Required, and first — the gateway has no opinion of its own. */
  worker: string;
}

/**
 * A label for the gateway's own temp directory: the host version, minus anything a path should
 * not carry.  It is the gateway's business alone — the payload is not told which label it is.
 */
function label(hostVersion: string | undefined): string {
  return (hostVersion ?? "unnamed").replace(/[^A-Za-z0-9.+@_-]/g, "-").slice(0, 80);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function flagValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
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
    ...(boot.hostVersion === undefined ? [] : [`--host-version=${boot.hostVersion}`]),
  ];
}

/** The boot a gateway was started with, or the reason it cannot start. */
export function gatewayBoot(argv: string[]): GatewayBoot {
  const worker = argv[0];
  if (worker === undefined || worker.startsWith("--")) {
    throw new Error("no <payload>: the gateway relays to a payload, named as its first argument");
  }
  const hostVersion = flagValue(argv, "host-version");
  return { ...(hostVersion === undefined ? {} : { hostVersion }), worker };
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
  const { hostVersion, worker } = booted;

  const dir = await mkdtemp(join(tmpdir(), `posipaki-${label(hostVersion)}-`));
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
    ...(hostVersion === undefined ? [] : [`--host-version=${hostVersion}`]),
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
