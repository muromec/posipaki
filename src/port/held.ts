// ── a channel that keeps what nobody was reading yet ────────────────────────
//
// A medium can deliver a frame in the same turn a reader is being installed, and a channel with no subscriber
// drops it.  This wraps a channel so nothing is dropped for want of a listener: what arrives while nobody is
// subscribed is kept and handed to the first reader that arrives.
//
// After that the channel is live, and a subscriber that comes later has missed what went before it.  That is not a
// limitation of this adapter: a channel delivers a frame once, and a channel that replayed its history to every new
// subscriber could never say whether anything was standing for one.
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
  /** The ending, kept for a reader that arrives after it: a channel that is over is not one to wait on. */
  let ending: { reason: C } | null = null;
  let failed: { error: unknown } | null = null;

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
    ending = { reason };
    for (const closer of [...closers]) closer(reason);
  });
  inner.onError((error) => {
    failed = { error };
    for (const failer of [...failers]) failer(error);
  });

  return {
    send: (frame) => inner.send(frame),
    onFrame(handler) {
      readers.add(handler);
      // Handed to the first reader and taken: a frame is delivered once, and what came before this one is not a
      // later reader's to have.
      const keptNow = [...kept];
      kept.length = 0;
      for (const frame of keptNow) handler(frame);
      return () => {
        readers.delete(handler);
      };
    },
    /** What it kept is handed to whoever subscribes next; what it will *push* is the inner channel's business. */
    hasFrames: () => inner.hasFrames(),
    onClose(handler) {
      if (ending !== null) {
        handler(ending.reason);
        return () => {};
      }
      closers.add(handler);
      return () => {
        closers.delete(handler);
      };
    },
    onError(handler) {
      if (failed !== null) {
        handler(failed.error);
        return () => {};
      }
      failers.add(handler);
      return () => {
        failers.delete(handler);
      };
    },
    close: (reason) => inner.close(reason),
    info: inner.info,
    control: (command) => inner.control(command),
  };
}
