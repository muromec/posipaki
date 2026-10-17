// ── stdio wire ─────────────────────────────────────────────────────────────
//
// A newline-delimited JSON channel over a pair of streams: the one wire every
// way into a foreign execution context can carry.  Two callers rely on it, and
// they are two halves of the same thing:
//
//   * the client of a spawn we make ourselves, on fds handed to the child (see
//     `fdStreams`) — private fds, so the child's own stdout stays free;
//   * a first-stage command on its own stdin/stdout, over ssh, under `sudo`, in
//     a container — where stdio is the only channel there is.
//
// Frames are one JSON object per line.  Whatever the far end prints is carried as an *output
// frame* (`$fd`), so it can never be mistaken for a frame of the protocol itself; a failed start
// is carried as an `$error` frame.
//
// Output frames are routed above the protocol step, by whoever holds the connection (output.ts):
// every line decodes to a frame, and the ones that are the far end's own print go to that
// holder's sink instead of to the seam.  The handshake below reads the first frame that is the
// protocol's, since the far end's own print may come first.

import { createReadStream, createWriteStream } from "node:fs";
import { readLines } from "./lines.js";
import type { Readable, Writable } from "node:stream";
import {
  errorFrame as wireErrorFrame,
  errorReason as wireErrorReason,
  isProto,
  outputOf,
  type Channel,
  type OutputFd,
  type StringTransport,
} from "./channel.js";
import { VERSION, json1Channel } from "./protocols/json1.js";
import { stderrSink, withOutput, type OutputSink } from "./output.js";

/** The stream pair a line transport talks over. */
export interface LineStreams {
  read: Readable;
  write: Writable;
}

/** How long to wait for the far end's first protocol frame. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Raised when the wire itself fails: no frame, the wrong protocol, a peer that went away. */
export class StdioWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StdioWireError";
  }
}

/** An `$error` frame as a line.  The word and its shape are the shared vocabulary's
 *  (channel.ts) — one word for a wire that cannot be spoken over, whether the failure was at
 *  the start of a session or in the middle of one; what this file owns is its line form. */
export function errorFrame(reason: string): string {
  return JSON.stringify(wireErrorFrame(reason));
}

/** The reason an `$error` frame carries, or null when it is not one. */
export function errorReason(frame: Record<string, unknown>): string | null {
  return wireErrorReason(frame);
}

// ── transports ─────────────────────────────────────────────────────────────

/** Is this write error just a peer that already left? */
function peerGone(code: unknown): boolean {
  return (
    code === "EPIPE" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_STREAM_WRITE_AFTER_END" ||
    code === "ERR_STREAM_ALREADY_FINISHED"
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A `StringTransport` over a read/write stream pair, one JSON frame per line.
 *
 * `close()` is idempotent and never throws: teardown races are normal here —
 * the peer exits, the read side ends, and a write arrives a moment later.
 */
export class LineTransport implements StringTransport {
  private readonly streams: LineStreams;
  private pvtOnMessage: ((line: string) => void) | null = null;
  private pvtOnClose: (() => void) | null = null;
  private pvtClosed = false;
  private pvtClosing: Promise<void> | null = null;

  constructor(streams: LineStreams) {
    this.streams = streams;
    readLines(
      streams.read,
      (line) => {
        if (this.pvtOnMessage && !this.pvtClosed) this.pvtOnMessage(line);
      },
      () => {
        this.pvtOnClose?.();
        void this.close();
      },
    );
    // A stream error is a peer that went away, not a reason to take the process
    // down with an unhandled 'error' event.
    streams.read.on("error", () => {
      void this.close();
    });
    streams.write.on("error", () => {
      void this.close();
    });
  }

  get closed(): boolean {
    return this.pvtClosed;
  }

  get hasHandler(): boolean {
    return this.pvtOnMessage !== null;
  }

  onMessage(handler: (line: string) => void): void {
    if (this.pvtClosed) throw new StdioWireError("stdio transport: closed");
    if (this.pvtOnMessage !== null) {
      throw new StdioWireError("stdio transport: handler already set — call removeHandler()");
    }
    this.pvtOnMessage = handler;
  }

  removeHandler(): ((line: string) => void) | null {
    const previous = this.pvtOnMessage;
    this.pvtOnMessage = null;
    return previous;
  }

  onClose(handler: () => void): void {
    this.pvtOnClose = handler;
  }

  send(frame: string): Promise<void> {
    if (this.pvtClosed) {
      return Promise.resolve();
    }
    const line = frame.endsWith("\n") ? frame : `${frame}\n`;
    return new Promise<void>((resolve, reject) => {
      try {
        this.streams.write.write(line, (err?: Error | null) => {
          if (!err) return resolve();
          const code = (err as { code?: unknown }).code;
          // A peer that has hung up cannot be told anything; the write that
          // races its exit is not an error in this transport.
          if (peerGone(code)) {
            return resolve();
          }
          reject(new StdioWireError(`stdio transport: ${err.message}`));
        });
      } catch (err) {
        reject(new StdioWireError(`stdio transport: ${errorText(err)}`));
      }
    });
  }

  async close(): Promise<void> {
    this.pvtClosing ??= this.pvtClose();
    await this.pvtClosing;
  }

  private async pvtClose(): Promise<void> {
    await Promise.resolve();

    this.pvtClosed = true;
    // Best effort: a half-open stream (the peer is already gone) must not turn
    // teardown into an exception.
    try {
      this.streams.read.destroy?.();
    } catch {
      /* already gone */
    }
    try {
      if (!this.streams.write.writableEnded) this.streams.write.end();
    } catch {
      /* already gone */
    }
  }
}

/** Streams over two fds of *our own* process — the child side of an fd wire. */
export function fdStreams(readFd: number, writeFd: number): LineStreams {
  const read = createReadStream("", { fd: readFd, encoding: "utf-8", autoClose: false });
  const write = createWriteStream("", { fd: writeFd, encoding: "utf-8", autoClose: false });
  return { read, write };
}

// ── handshakes ─────────────────────────────────────────────────────────────

/** The next frame that is the protocol's, or a timeout.  The far end's own output is not the
 *  protocol's: it goes to `sink` while this waits, and the wait carries on. */
async function nextFrame(
  channel: Channel,
  timeoutMs: number,
  sink: OutputSink,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new StdioWireError(`no protocol frame within ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
      const off = channel.onMessage((frame) => {
        const output = outputOf(frame);
        if (output) {
          sink(output.fd, output.data);
          return;
        }
        off();
        clearTimeout(timer);
        resolve(frame);
      });
  });
}

export interface ClientChannelOptions {
  /** Where the far end's own output goes.  Defaults to our stderr. */
  onOutput?: OutputSink;
  /** How long to wait for the peer's protocol frame.  Defaults to {@link HANDSHAKE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * The client end of the connection: hand the streams to the seam and wait for the peer's `$proto`,
 * with the far end's own output going to `onOutput` (our stderr by default) as it arrives.  A
 * first stage reports a failed start as an `$error` frame instead.
 */
export async function clientChannel(
  streams: LineStreams,
  opts: ClientChannelOptions = {},
): Promise<Channel> {
  const channel = json1Channel(new LineTransport(streams));
  const sink = opts.onOutput ?? stderrSink();
  const frame = await nextFrame(channel, opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS, sink);

  const reason = errorReason(frame);
  if (reason) throw new StdioWireError(reason);
  if (!isProto(frame)) {
    throw new StdioWireError(`unexpected first frame: ${JSON.stringify(frame).slice(0, 120)}`);
  }
  if (frame.$proto !== VERSION) {
    throw new StdioWireError(`unsupported protocol ${String(frame.$proto)}, expected ${VERSION}`);
  }
  // From here on the far end's own output is this connection's business and not the transport's:
  // every frame reaches the seam, and the ones that are its print are taken off on the way in.
  return withOutput(channel, sink);
}

/** The server end of the wire — a payload speaking stdio itself. */
export async function serverChannel(streams: LineStreams): Promise<Channel> {
  const channel = json1Channel(new LineTransport(streams));
  await channel.send({ $proto: VERSION });
  return channel;
}
