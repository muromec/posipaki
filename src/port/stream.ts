// ── a stream pair as a channel of bytes ────────────────────────────────
//
// Chunks out as they arrive, chunks in as they are written, and an ending.  Framing, splitting and the meaning
// of a frame compose on top of this.
//
// A send settles when the stream has flushed the chunk, not when it has accepted it into a buffer, so a writer
// cannot run ahead of the pipe without waiting.
//
// Two of the three endings are discovered here rather than declared: a read side that ends is a peer that
// closed, and a broken stream is a wire that failed.

import type { Readable, Writable } from "node:stream";

import { ChannelClosed, type Channel } from "./channel.js";

/** What the channel talks over: something to read from, something to write to. */
export interface StreamPair {
  read: Readable;
  write: Writable;
}

/** A write error that means the peer has already hung up. */
function peerGone(code: unknown): boolean {
  return (
    code === "EPIPE" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_STREAM_WRITE_AFTER_END" ||
    code === "ERR_STREAM_ALREADY_FINISHED"
  );
}

function asBytes(chunk: Buffer | string): Uint8Array {
  if (typeof chunk === "string") return new Uint8Array(Buffer.from(chunk, "utf8"));
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * A channel of bytes over a stream pair.
 *
 * `close()` ends the write side, so the far end hears an end of stream, and destroys the read side, so no
 * more chunks arrive after this side has said it is done.  A peer that goes away is a close of this side's
 * own readers, and the reason says which of the two it was.
 */
export function streamChannel(pair: StreamPair): Channel<Uint8Array> {
  const frames = new Set<(frame: Uint8Array) => void>();
  const closers = new Set<(reason: string) => void>();
  const failers = new Set<(error: unknown) => void>();
  /** What this side's readers were told, and null while they have been told nothing. */
  let reported: string | null = null;
  let ended = false;

  const release = (): void => {
    // Best effort: a stream whose peer is gone throws from `destroy` and from `end`, and teardown is not
    // the place to find out.
    try {
      pair.read.destroy();
    } catch {
      /* already gone */
    }
    try {
      if (!pair.write.writableEnded) pair.write.end();
    } catch {
      /* already gone */
    }
  };

  /** End it from this side: the far end hears it, and this side's readers do not — they asked. */
  const shut = (): void => {
    if (ended) return;
    ended = true;
    release();
  };

  /** The far end is gone, and this side's readers hear it. */
  const finish = (reason: string): void => {
    if (ended) return;
    ended = true;
    reported = reason;
    release();
    for (const closer of [...closers]) closer(reason);
  };

  /** The wire failed: this side hears the error once, and then a close. */
  const fail = (error: unknown): void => {
    if (ended) return;
    ended = true;
    reported = "the wire failed";
    release();
    for (const failer of [...failers]) failer(error);
    for (const closer of [...closers]) closer("the wire failed");
  };

  pair.read.on("data", (chunk: Buffer | string) => {
    if (ended) return;
    const bytes = asBytes(chunk);
    for (const reader of [...frames]) reader(bytes);
  });
  pair.read.on("end", () => finish("the far end closed"));
  // A stream destroyed without an end — a socket whose peer vanished — says so only here.
  pair.read.on("close", () => finish("the far end closed"));
  pair.read.on("error", (error: Error) => fail(error));
  pair.write.on("error", (error: Error) => fail(error));

  const send = (frame: Uint8Array): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (ended) {
        reject(new ChannelClosed(reported ?? "closed here"));
        return;
      }
      const done = (err?: Error | null): void => {
        if (err === undefined || err === null) {
          resolve();
          return;
        }
        if (peerGone((err as { code?: unknown }).code)) {
          finish("the peer is gone");
          reject(new ChannelClosed("the peer is gone"));
          return;
        }
        fail(err);
        reject(err);
      };
      try {
        pair.write.write(frame, done);
      } catch (err) {
        fail(err);
        reject(err);
      }
    });

  return {
    send,
    onFrame: (handler) => {
      frames.add(handler);
      return () => {
        frames.delete(handler);
      };
    },
    onClose: (handler) => {
      if (reported !== null) {
        handler(reported);
        return () => {};
      }
      closers.add(handler);
      return () => {
        closers.delete(handler);
      };
    },
    onError: (handler) => {
      failers.add(handler);
      return () => {
        failers.delete(handler);
      };
    },
    close: () => {
      shut();
      return Promise.resolve();
    },
    info: {},
    control: () => {},
  };
}
