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
// Frames are one JSON object per line.  Whatever the far end prints is carried
// as an *output frame* (`$fd`), so it can never be mistaken for a frame of the
// protocol itself; a failed start is carried as an `$error` frame.
//
// Why the client filters output frames before handing the transport to the
// seam: `json1Channel` decodes every line it sees, and the first frame of a
// session is the peer's `$proto`.  Stripping output frames in the transport
// keeps the protocol view clean without the seam knowing anything about them.

import { createReadStream, createWriteStream } from "node:fs";
import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isProto, type Channel, type StringTransport } from "./channel.js";
import { VERSION, json1Channel } from "./protocols/json1.js";

/** The stream pair a line transport talks over. */
export interface LineStreams {
  read: Readable;
  write: Writable;
}

/** A stream of the far end's process: its stdout or its stderr. */
export type OutputFd = 1 | 2;

/** Where the far end's own output goes. */
export type OutputSink = (fd: OutputFd, data: string) => void;

/** How long to wait for the far end's first protocol frame. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

const OUTPUT_KEY = "$fd";

const ERROR_KEY = "$error";

/** Raised when the wire itself fails: no frame, the wrong protocol, a peer that went away. */
export class StdioWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StdioWireError";
  }
}

// ── output frames ──────────────────────────────────────────────────────────

/** One frame of the far end's own output. */
export interface OutputFrame {
  fd: OutputFd;
  data: string;
}

export function outputFrame(fd: OutputFd, data: string): string {
  return JSON.stringify({ [OUTPUT_KEY]: fd, data });
}

/** The output frame a line carries, or null when it carries something else. */
export function parseOutputFrame(line: string): OutputFrame | null {
  // Cheap reject first: almost every line of a session is protocol traffic.
  if (!line.startsWith('{"$fd"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  const fd = frame[OUTPUT_KEY];
  const data = frame.data;
  if (fd !== 1 && fd !== 2) return null;
  return { fd, data: typeof data === "string" ? data : JSON.stringify(data) };
}

export function errorFrame(reason: string): string {
  return JSON.stringify({ [ERROR_KEY]: reason });
}

/** The reason an `$error` frame carries, or null when it is not one. */
export function errorReason(frame: Record<string, unknown>): string | null {
  const reason = frame[ERROR_KEY];
  return typeof reason === "string" ? reason : null;
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
    const lines = readline.createInterface({ input: streams.read });
    lines.on("line", (line) => {
      if (this.pvtOnMessage && !this.pvtClosed) this.pvtOnMessage(line);
    });
    lines.on("close", () => {
      this.pvtOnClose?.();
      void this.close();
    });
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

/**
 * A transport that lifts output frames out of the stream: everything else is
 * passed through untouched, so the protocol sees frames and only frames.
 */
export class OutputFilter implements StringTransport {
  private readonly inner: StringTransport;
  private readonly sink: OutputSink;

  constructor(inner: StringTransport, sink: OutputSink) {
    this.inner = inner;
    this.sink = sink;
  }

  send(frame: string): void | Promise<void> {
    return this.inner.send(frame);
  }

  onMessage(handler: (frame: string) => void): void {
    this.inner.onMessage((line) => {
      const output = parseOutputFrame(line);
      if (output) this.sink(output.fd, output.data);
      else handler(line);
    });
  }

  removeHandler(): void {
    this.inner.removeHandler();
  }

  onClose(handler: () => void): void {
    this.inner.onClose(handler);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

// ── sinks ──────────────────────────────────────────────────────────────────

/** Write the far end's output to our stderr, tagged with its name. */
export function stderrSink(name = ""): OutputSink {
  const tag = name ? `[${name}] ` : "";
  return (fd, data) => {
    const lead = fd === 1 ? tag : `${tag}err: `;
    for (const line of data.split("\n")) {
      if (line.length > 0) process.stderr.write(`${lead}${line}\n`);
    }
  };
}

// ── handshakes ─────────────────────────────────────────────────────────────

/** The next frame that arrives, or a timeout. */
async function nextFrame(channel: Channel, timeoutMs: number): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new StdioWireError(`no protocol frame within ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    channel.onMessage((frame) => {
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
 * The client end of the wire: hand the streams to the seam (minus output
 * frames) and wait for the peer's `$proto`.  A first stage reports a failed
 * start as an `$error` frame instead.
 */
export async function clientChannel(
  streams: LineStreams,
  opts: ClientChannelOptions = {},
): Promise<Channel> {
  const transport = new LineTransport(streams);
  const channel = json1Channel(new OutputFilter(transport, opts.onOutput ?? stderrSink()));
  const frame = await nextFrame(channel, opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  channel.removeHandler();

  const reason = errorReason(frame);
  if (reason) throw new StdioWireError(reason);
  if (!isProto(frame)) {
    throw new StdioWireError(`unexpected first frame: ${JSON.stringify(frame).slice(0, 120)}`);
  }
  if (frame.$proto !== VERSION) {
    throw new StdioWireError(`unsupported protocol ${String(frame.$proto)}, expected ${VERSION}`);
  }
  return channel;
}

/** The server end of the wire — a payload speaking stdio itself. */
export async function serverChannel(streams: LineStreams): Promise<Channel> {
  const channel = json1Channel(new LineTransport(streams));
  await channel.send({ $proto: VERSION });
  return channel;
}
