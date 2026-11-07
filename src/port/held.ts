// ── a channel that keeps what nobody was reading yet ────────────────────────
//
// A medium can deliver a frame in the same turn a reader is being installed, and a channel with no subscriber
// drops it.  This wraps a channel so nothing is dropped for want of a listener: what arrives while nobody is
// subscribed is kept, and every subscriber that arrives before the first frame is delivered is given it.
//
// The window ends at the first delivery.  After that the channel is live, and a subscriber that comes later has
// missed what went before it — which is what any live channel means, and the alternative would be an unbounded
// copy of everything ever said.

import type { Channel } from "./channel.js";

/**
 * `inner`, with the frames that arrive before anyone is subscribed kept for the readers that follow.
 *
 * The kept frames are not bounded, because a bound depends on what the far end may say before anyone listens,
 * and that is not something this adapter can know.
 */
export function held<F, C>(inner: Channel<F, C>): Channel<F, C> {
  const readers = new Set<(frame: F) => void>();
  const closers = new Set<(reason: C) => void>();
  const failers = new Set<(error: unknown) => void>();
  const kept: F[] = [];
  let live = false;

  const emit = (frame: F): void => {
    for (const reader of [...readers]) reader(frame);
  };

  inner.onFrame((frame) => {
    if (live) {
      emit(frame);
      return;
    }
    if (readers.size === 0) {
      kept.push(frame);
      return;
    }
    // Somebody is reading: from here the channel is live, and what was kept has been taken.
    live = true;
    kept.length = 0;
    emit(frame);
  });
  inner.onClose((reason) => {
    for (const closer of [...closers]) closer(reason);
  });
  inner.onError((error) => {
    for (const failer of [...failers]) failer(error);
  });

  return {
    send: (frame) => inner.send(frame),
    onFrame(handler) {
      readers.add(handler);
      // Handed to every subscriber that arrives before the first delivery, not only to the first.
      for (const frame of kept) handler(frame);
      return () => {
        readers.delete(handler);
      };
    },
    onClose(handler) {
      closers.add(handler);
      return () => {
        closers.delete(handler);
      };
    },
    onError(handler) {
      failers.add(handler);
      return () => {
        failers.delete(handler);
      };
    },
    close: (reason) => inner.close(reason),
  };
}
