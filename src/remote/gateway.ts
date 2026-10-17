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

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { channelThrough } from "./channel.js";
import { json1Channel } from "./protocols/json1.js";
import { lowBand } from "./process-ref.js";
import { StreamStore } from "./stream.js";
import { errorFrame } from "./stdio.js";
import type { LineTransport } from "./stdio.js";
import { LineTransport as Lines } from "./stdio.js";
import { FifoUtf8NlineTransport } from "./transports/fifo.js";

const run = promisify(execFile);

/** How much of a dying payload's own words travels in the reason a failed start carries. */
const REASON_TAIL = 4096;

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

/** The payload's own prints, as a stream: the pipe's chunks as they arrive. */
async function* chunksOf(stream: NodeJS.ReadableStream, prefix = ""): AsyncIterable<Uint8Array> {
  if (prefix.length > 0) yield new TextEncoder().encode(prefix);
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
  }
}

/** Everything a payload printed into its pipes, up to the point they end: what a start that dies
 *  before its channel says about itself.  A stream cannot carry it — there is no connection yet. */

/**
 * Serve one environment over stdin/stdout.  Returns the exit code; the caller
 * turns it into `process.exitCode`.
 */
export async function runGateway(argv: string[] = process.argv.slice(2)): Promise<number> {
  const wire = new Lines({ read: process.stdin, write: process.stdout });
  // One channel on the client wire, and the ids this gateway speaks from: the low band, which neither
  // the client nor the payload allocates in, so a stream of its own cannot collide with one of theirs.
  // The store answers only for the streams it offered; everything else belongs to the far side.
  const client = json1Channel(wire);
  const output = new StreamStore(client, "even", { ids: lowBand("even"), attach: false });

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
  /** What the payload printed before the client spoke: a start that dies that early has no connection
   *  to announce a stream on, and its words are the only way to say why it went.  Kept per stream, so
   *  the output that comes after is still attributed to the right one. */
  const early = { stdout: "", stderr: "" };
  const keep =
    (name: "stdout" | "stderr") =>
    (chunk: Buffer | string): void => {
      early[name] = (early[name] + String(chunk)).slice(-REASON_TAIL);
    };
  const keepOut = keep("stdout");
  const keepErr = keep("stderr");
  workerProc.stdout?.on("data", keepOut);
  workerProc.stderr?.on("data", keepErr);

  /** Announce the payload's own output as the two streams a program's prints belong on, with whatever
   *  it said before the connection could carry it replayed as the first chunk. */
  const offerOutput = (): void => {
    const sides = [
      { stream: workerProc.stdout, name: "stdout", keep: keepOut },
      { stream: workerProc.stderr, name: "stderr", keep: keepErr },
    ] as const;
    for (const { stream, name, keep: drop } of sides) {
      if (!stream) continue;
      stream.off("data", drop);
      stream.pause();
      output.offer(chunksOf(stream, early[name]), name);
    }
  };

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
    // A payload that dies before it opens its channel printed into pipes nobody is reading yet: its
    // last words are the only way to say why, and they are not a stream because no connection exists
    // to announce one on.
    const said = `${early.stdout}${early.stderr}`.trim();
    await fail(wire, `${errorText(err)}${said ? `: ${said}` : ""}`);
    await teardown();
    abandon();
  }

  // Relay frames, not lines: the gateway has streams of its own now — the payload's output — and one
  // the store claims is the gateway's, not the payload's business.  Everything else crosses unchanged.
  // `fifo` is settled by the race above: a start that failed took the exit path and never got here.
  const payload = json1Channel(fifo as FifoUtf8NlineTransport);
  const fromClient = channelThrough(client, (frame) => output.handle(frame));
  const forward = (send: (frame: Record<string, unknown>) => unknown, frame: Record<string, unknown>): void => {
    void Promise.resolve(send(frame)).catch(() => {
      /* the far side is gone; its own exit path cleans up */
    });
  };
  let offered = false;
  fromClient.onMessage((frame) => {
    if (!offered) {
      offered = true;
      // The client has spoken, which means its store exists: an announcement made before that would
      // land in a connection with nobody listening for it.
      offerOutput();
    }
    forward((next) => payload.send(next), frame);
  });
  fromClient.onSegment?.((head, bytes) => {
    payload.sendSegment?.(head, bytes);
  });
  payload.onMessage((frame) => {
    forward((next) => client.send(next), frame);
  });
  payload.onSegment?.((head, bytes) => {
    client.sendSegment?.(head, bytes);
  });
  client.onClose(() => {
    child?.kill();
  });

  const code = await exited;
  await teardown();
  await wire.close();
  return code;
}
