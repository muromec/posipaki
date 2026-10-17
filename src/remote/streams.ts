// ── the connection's own logs ───────────────────────────────────────────────
//
// A program's prints are a stream it announces under a name (`stdout`, `stderr`) and the other side
// reads like any other stream; what is left here is the conversion a *log* needs — lines out of
// octets, at the level the stream says.  The fd frames this file used to build are gone: the bytes
// travel as streams, with credit and checksums, and the name says what they are.

import { Writable } from "node:stream";

/**
 * What a log line needs: a stream says `info` or `warn`, and nothing here cares which logger it is.
 * The seam states the two methods rather than importing one, so a debug logger, a console or a test's
 * own collector all fit without the remote layer depending on a plugin.
 */
export interface LineLog {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/**
 * A writable that turns what is written to it into log lines: `stderr` arrives as `warn` and every
 * other name as `info`, and the tail is held until a newline (or the end) so a chunk boundary is not
 * a line boundary.
 */
export function logStream(log: LineLog, opts: { name?: string } = {}): Writable {
  const warn = opts.name === "stderr";
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
