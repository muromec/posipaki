// ── A channel with no medium ────────────────────────────────────────────────
//
// Two ends over nothing: what one sends, the other reads.  It exists so that an adapter, a protocol or a
// protocol's tests can be written without a socket, a child or a file — and so that a channel's three endings
// have somewhere to be exercised that is not a fake of one of them.
//
// No queue and no asynchrony beyond the promise: a frame is handed to the other end before `send` settles.  A
// medium with a buffer of its own would be a different fake, and a test that needed one would be a test of the
// buffer.

import { ChannelClosed, type Channel } from "./channel.js";

/** One end of a pair, plus the one thing a medium would do that nothing else can. */
export interface MemoryEnd<F> extends Channel<F> {
  /** Break the wire: the far end hears an error, and then a close. */
  fail(error: unknown): void;
}

export interface ChannelPair<F> {
  near: MemoryEnd<F>;
  far: MemoryEnd<F>;
}

type Side = "near" | "far";

interface End<F> {
  frames: Set<(frame: F) => void>;
  closes: Set<(reason: string) => void>;
  errors: Set<(error: unknown) => void>;
}

function end<F>(): End<F> {
  return { frames: new Set(), closes: new Set(), errors: new Set() };
}

/** The two halves of one channel. */
export function memoryChannelPair<F>(): ChannelPair<F> {
  const near = end<F>();
  const far = end<F>();
  const closed: Record<Side, string | null> = { near: null, far: null };
  const other = (side: Side): Side => (side === "near" ? "far" : "near");

  /** One side's own state and the other side's, which is all a channel is. */
  const make = (side: Side): MemoryEnd<F> => {
    const mine = side === "near" ? near : far;
    const theirs = side === "near" ? far : near;
    return {
      send: async (frame: F) => {
        const ended = closed[side] ?? closed[other(side)];
        if (ended !== null) throw new ChannelClosed(ended);
        for (const handler of [...theirs.frames]) handler(frame);
      },
      onFrame: (handler) => {
        mine.frames.add(handler);
        return () => {
          mine.frames.delete(handler);
        };
      },
      onClose: (handler) => {
        mine.closes.add(handler);
        return () => {
          mine.closes.delete(handler);
        };
      },
      onError: (handler) => {
        mine.errors.add(handler);
        return () => {
          mine.errors.delete(handler);
        };
      },
      close: async (reason = "closed here") => {
        if (closed[side] !== null) return;
        const peer = other(side);
        closed[side] = reason;
        if (closed[peer] !== null) return;
        closed[peer] = reason;
        for (const handler of [...theirs.closes]) handler(reason);
      },
      fail: (error: unknown) => {
        if (closed[side] !== null) return;
        const peer = other(side);
        if (closed[peer] !== null) return;
        for (const handler of [...theirs.errors]) handler(error);
        for (const handler of [...theirs.closes]) handler("the wire failed");
        closed[side] = "the wire failed";
        closed[peer] = "the wire failed";
      },
    };
  };

  return { near: make("near"), far: make("far") };
}
