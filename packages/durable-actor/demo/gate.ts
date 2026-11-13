// ── a channel that can be cut ───────────────────────────────────────────────

import { ChannelClosed, type Channel } from 'posipaki/port';

/** A channel, and the switch that stops what it carries. */
export interface Gate<R> {
  channel: Channel<R, string>;
  cut(): void;
  heal(): void;
  readonly cutNow: boolean;
}

/**
 * A channel that can be cut: while it is, nothing it carries arrives and nothing may be sent.
 *
 * A cut is a partition, not a pause: what happens on either side of it is what happens in a network that has
 * split, which is the thing the demo is there to show.  Each reader is gated on its own — a source that hands a
 * follower its starting state when it subscribes would lose it to an eager wrapper.
 */
export function gateChannel<R>(inner: Channel<R, string>): Gate<R> {
  let cut = false;

  const channel: Channel<R, string> = {
    async send(record: R): Promise<void> {
      if (cut) throw new ChannelClosed('the channel is cut');
      await inner.send(record);
    },
    onFrame(handler) {
      return inner.onFrame((record) => {
        if (cut) return;
        handler(record);
      });
    },
    onClose: (handler) => inner.onClose(handler),
    onError: (handler) => inner.onError(handler),
    close: (reason) => inner.close(reason),
    get info() {
      return inner.info;
    },
    control: (command) => inner.control(command),
  };

  return {
    channel,
    cut: () => {
      cut = true;
    },
    heal: () => {
      cut = false;
    },
    get cutNow() {
      return cut;
    },
  };
}
