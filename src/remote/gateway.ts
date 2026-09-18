// ── Gateway ────────────────────────────────────────────────────────────────
//
// The first-stage command.  Run this *inside* a foreign environment — directly,
// under `sudo`, over ssh, in a container — and it:
//
//   1. creates the channel to the payload (fifo paths it makes itself, in a
//      private temp dir, so they belong to the uid that will open them),
//   2. starts the payload — the first argument, required — hands it everything else it was
//      given (the host version among it) and relays frames between stdin/stdout,
//   3. carries whatever the payload prints to the client as output frames
//      (`$fd`), so the payload's own stdout can never be mistaken for protocol.
//
// Why a gateway at all: a fifo path created on the client side is useless when the
// payload runs as another uid (it cannot open it) or on another host (the path is
// not there).  stdio is the one channel every way into an environment gives us, so
// the wire is stdio and the fifo stays inside the environment.
//
// The gateway reads nothing out of what it carries and owns no flag: the payload's path and
// every argument after it go through verbatim, in order.  The payload is the one who refuses a
// host version it is not, and a relay that judged would be a second place for that decision.
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
import { basename, join } from "node:path";
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
   * The program to start for the payload: the first word of the command the client composed —
   * a runtime, or a program that runs itself.  Required, and first, and the gateway has no
   * opinion of its own about which it is.
   */
  worker: string;
  /**
   * Everything after the payload, carried to it **as is** and in order: the consumer's own
   * arguments, and posipaki's own facts among them (the host version travels this way).  The
   * gateway reads nothing by name and owns no flag, so nothing of the caller's is interpreted,
   * eaten, re-ordered or re-spelled — and the next fact added to that line needs no new
   * vocabulary here.
   */
  passthrough: string[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A label for the gateway's own temp directory: the program this environment was made for.
 * It is the gateway's business alone — the payload is not told which label it is.
 */
function label(worker: string): string {
  const name = basename(worker).replace(/[^A-Za-z0-9.+@_-]/g, "-").slice(0, 60);
  return name === "" ? "payload" : name;
}

/**
 * The argv that boots this gateway — built by the client, read by
 * {@link gatewayBoot}, so the two halves cannot drift apart.
 *
 * The payload comes first and its arguments after it, so a positional argument of the
 * payload's own can never be mistaken for the payload.
 */
export function gatewayArgs(boot: GatewayBoot): string[] {
  return [boot.worker, ...boot.passthrough];
}

/** The boot a gateway was started with, or the reason it cannot start. */
export function gatewayBoot(argv: string[]): GatewayBoot {
  const [worker, ...passthrough] = argv;
  if (worker === undefined || worker.startsWith("--")) {
    throw new Error("no <payload>: the gateway relays to a payload, named as its first argument");
  }
  return { passthrough, worker };
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
  const { passthrough, worker } = booted;

  const dir = await mkdtemp(join(tmpdir(), `posipaki-${label(worker)}-`));
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
  const workerArgs = [worker, ...passthrough, `--fifo-in=${fifoIn}`, `--fifo-out=${fifoOut}`];
  // Whatever the client said starts the payload, run as it said: a runtime with a script of
  // ours, or a program of the caller's own.  The gateway does not know which it is, and does
  // not choose a runtime on the far end's behalf.
  const workerProc = spawn(workerArgs[0]!, workerArgs.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
  });
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
