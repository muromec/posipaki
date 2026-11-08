// ── a pair of channels as one ───────────────────────────────────────────────
//
// A medium that has an inbound side and an outbound side — a request and its answer, a socket's reader and its
// writer — arrives as two channels.  A channel has one frame type, so this is only for a pair whose two sides
// carry the same one: frames arrive from the inbound side, `send` writes to the outbound side, `close()` ends it.
//
// The ending is the inbound side's: when the far side has sent everything, this channel closes with whatever that
// side said.  Closing it here closes the outbound side, which is how an answer is finished.

import type { Channel } from "./channel.js";

/** A pair whose two sides carry the same frame type, read as one channel. */
export function duplexChannel<F, C = void>(pair: {
  readonly inbound: Channel<F, C>;
  readonly outbound: Channel<F, C>;
}): Channel<F, C> {
  return {
    send: (frame) => pair.outbound.send(frame),
    onFrame: (handler) => pair.inbound.onFrame(handler),
    onClose: (handler) => pair.inbound.onClose(handler),
    onError: (handler) => pair.inbound.onError(handler),
    close: async (reason) => {
      await pair.outbound.close(reason);
    },
    info: { ...pair.inbound.info, ...pair.outbound.info },
    control: (command) => pair.inbound.control(command),
  };
}
