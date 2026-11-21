// ── one vocabulary as another ─────────────────────────────────────────────
//
// One layer of a stack: what this side sends is mapped down, what arrives is mapped up, and a value its mapper
// skips goes nowhere.  The ending, the info and the control of the channel below are forwarded untouched — a
// layer above does not own the medium.

import type { Channel } from "./channel.js";

/** What a mapper returns when a value has nothing to say in the other vocabulary. */
export const SKIP = Symbol('skip');

/**
 * A channel of `I` over a channel of `O`.
 *
 * `down` maps what is sent and `up` maps what arrives; either may answer `SKIP`, and then nothing is written
 * or delivered.  Everything else — close, error, info, control — is the channel below's own, forwarded as it
 * is, because this layer carries a vocabulary and not a medium.
 */
export function mapChannel<I, O, C>(
  inner: Channel<O, C>,
  down: (value: I) => O | typeof SKIP,
  up: (value: O) => I | typeof SKIP,
): Channel<I, C> {
  return {
    async send(value: I): Promise<void> {
      const frame = down(value);
      if (frame === SKIP) return;
      await inner.send(frame);
    },
    onFrame(handler: (frame: I) => void): () => void {
      return inner.onFrame((frame: O) => {
        const value = up(frame);
        if (value === SKIP) return;
        handler(value);
      });
    },
    onClose: (handler) => inner.onClose(handler),
    onError: (handler) => inner.onError(handler),
    close: (reason) => inner.close(reason),
    get info() {
      return inner.info;
    },
    control: (command) => inner.control(command),
    hasFrames: () => inner.hasFrames(),
  };
}

/**
 * A channel of `I` over a channel of `O`, where one value is several frames and one frame is several values.
 *
 * `up` answers what one frame carries: every value reaches the reader before that frame's turn is over, so a reader
 * acting on the first has the rest coming in the same turn — a caller that reads one value per frame may rely on it.
 * `down` answers what one value needs, written in order.  An empty array is this mapper's `SKIP`.
 */
export function mapChannelMany<I, O, C>(
  inner: Channel<O, C>,
  down: (value: I) => readonly O[],
  up: (value: O) => readonly I[],
): Channel<I, C> {
  return {
    async send(value: I): Promise<void> {
      for (const frame of down(value)) await inner.send(frame);
    },
    onFrame(handler: (frame: I) => void): () => void {
      return inner.onFrame((frame: O) => {
        for (const value of up(frame)) handler(value);
      });
    },
    onClose: (handler) => inner.onClose(handler),
    onError: (handler) => inner.onError(handler),
    close: (reason) => inner.close(reason),
    get info() {
      return inner.info;
    },
    control: (command) => inner.control(command),
    hasFrames: () => inner.hasFrames(),
  };
}
