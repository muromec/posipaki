// ── the connection as byte streams ─────────────────────────────────────────
//
// A frame with `$fd` is what one end's root says on one of its own streams (`outputFrame`,
// channel.ts): the number is the stream a program knows, and both directions of a stream live
// under it.  This is the layer that turns those frames into the streams a program holds, so a
// logger, a terminal or a child's own stdio plugs into a connection with a pipe.
//
//   channel ──{$fd: 1, data}──▶ stdout.read     what the other root printed
//   channel ◀─{$fd: 1, data}──── stdout.write    what this root prints
//
// Both directions on one fd, because both ends have a root and each reads what the other prints.
// Nothing is buffered beyond the streams themselves: a `read` nobody drains grows, and a `write`
// is one frame per chunk.

import { PassThrough, Writable, type Readable } from "node:stream";

import { outputFrame, outputOf, type Channel, type OutputFd } from "./channel.js";

/**
 * What a log line needs: a stream says `info` or `warn`, and nothing here cares which logger it is.
 * The seam states the two methods rather than importing one, so a debug logger, a console or a test's
 * own collector all fit without the remote layer depending on a plugin.
 */
export interface LineLog {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/** One stream of a connection: what the other end's root says on it, and what this end's root says. */
export interface FdStream {
  /** The other end's root, printing on this stream of its own. */
  readonly read: Readable;
  /** This end's root, printing on this stream; the other end reads it. */
  readonly write: Writable;
}

/** The three streams of a connection, and the one way to let them go. */
export interface FdSet {
  readonly stdin: FdStream;
  readonly stdout: FdStream;
  readonly stderr: FdStream;
  /** Stop reading the connection, and end every stream of it. */
  close(): void;
}

/** Where a frame goes: a connection's own `send`, or a transport's, encoded. */
export type OutputSender = (frame: Record<string, unknown>) => void | Promise<void>;

/**
 * A writable that writes what is written to it as output frames of one fd: one chunk is one frame.
 *
 * The shape of an output frame lives here rather than at each caller — the gateway relays a payload's
 * own output and holds no channel — and a send that fails is the stream's error, not a lost line.
 */
export function fdWriter(send: OutputSender, fd: OutputFd): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, done): void {
      // `send` may answer nothing (a transport that writes synchronously): either way the chunk is
      // taken once it is out, and a failure is the stream's to report.
      void Promise.resolve(send(outputFrame(fd, String(chunk)))).then(
        () => done(),
        (error: unknown) => done(error as Error),
      );
    },
  });
}

/**
 * The byte streams of a connection: what each end's root prints, and what it reads.
 *
 * The frames are the connection's, so anyone may also read them directly (`Channel.onMessage`); what
 * this adds is the shape a program outside the seam already speaks.
 */
export function connectionFds(channel: Channel): FdSet {
  const sides = new Map<OutputFd, { stream: FdStream; read: PassThrough }>();

  const side = (fd: OutputFd): FdStream => {
    const read = new PassThrough();
    const stream: FdStream = { read, write: fdWriter((frame) => channel.send(frame), fd) };
    sides.set(fd, { stream, read });
    return stream;
  };

  const stdin = side(0);
  const stdout = side(1);
  const stderr = side(2);

  const off = channel.onMessage((frame) => {
    const output = outputOf(frame);
    if (!output) return;
    sides.get(output.fd)?.read.push(output.data);
  });

  return {
    stdin,
    stdout,
    stderr,
    close(): void {
      off();
      for (const { stream, read } of sides.values()) {
        read.end();
        stream.write.end();
      }
    },
  };
}

/**
 * A writable that turns what is written to it into log lines: fd 1 arrives as `info` and fd 2 as
 * `warn`, and the tail is held until a newline (or the end) so a chunk boundary is not a line
 * boundary.
 */
export function logStream(log: LineLog, opts: { fd?: OutputFd } = {}): Writable {
  const warn = opts.fd === 2;
  const say = (line: string): void => {
    if (warn) log.warn(line);
    else log.info(line);
  };

  let tail = "";
  /** Everything up to the last newline goes out; what follows one waits to be finished. */
  const drain = (): void => {
    const lines = tail.split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) say(line);
    }
  };

  return new Writable({
    write(chunk: Buffer | string, _encoding, done): void {
      tail += String(chunk);
      drain();
      done();
    },
    final(done): void {
      drain();
      if (tail.length > 0) say(tail);
      done();
    },
  });
}
