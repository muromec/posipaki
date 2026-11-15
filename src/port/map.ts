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
