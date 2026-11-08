// ── several channels as one ─────────────────────────────────────────────────
//
// Two combinators, named after the promise pair because the choice is the same one: do you stop at the first
// ending, or do you wait for every channel to say how it ended?
//
// `all` is the first: a frame from any source arrives tagged with the source, and the first ending ends the
// combined channel with that source's reason.  `settled` is the second: every ending arrives as a frame of its
// own, tagged the same way, and the combined channel closes once all of them have.
//
// Neither sends.  A combined channel is made of others, so a frame put on it has no destination; `send`
// rejects and says so, and `close` closes every source.

import type { Channel } from "./channel.js";

/** A frame, and which of the combined channels it arrived on. */
export interface Sourced<T, F> {
  readonly source: T;
  readonly frame: F;
}

/** An ending, and which of the combined channels ended. */
export interface Ended<T, C> {
  readonly source: T;
  readonly ending: C;
}

function sendRefusal<T>(sources: T[]): Error {
  return new Error(`this channel is made of ${sources.length}: send on one of them, not on the combination`);
}

/**
 * Every frame from every source, tagged; the first ending ends it.
 *
 * The ending is the first one to arrive, and the others are ignored afterwards.  This is what a process wants
 * by default: its stdout ending means the process is gone, and that is the news.
 */
export function all<T extends string, F, C>(sources: Record<T, Channel<F, C>>): Channel<Sourced<T, F>, C> {
  const names = Object.keys(sources) as T[];
  const readers = new Set<(frame: Sourced<T, F>) => void>();
  const closers = new Set<(reason: C) => void>();
  const failers = new Set<(error: unknown) => void>();
  let ended = false;
  /** What the first ending said, for a reader that subscribes after it. */
  let ending: C | undefined;

  const end = (reason: C): void => {
    if (ended) return;
    ended = true;
    ending = reason;
    for (const closer of [...closers]) closer(reason);
  };

  for (const name of names) {
    const source = sources[name];
    source.onFrame((frame) => {
      for (const reader of [...readers]) reader({ source: name, frame });
    });
    source.onClose(end);
    source.onError((error) => {
      for (const failer of [...failers]) failer(error);
    });
  }

  return {
    send: () => Promise.reject(sendRefusal(names)),
    onFrame(handler) {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    onClose(handler) {
      if (ending !== undefined) {
        handler(ending);
        return () => {};
      }
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
    async close(reason?: string) {
      ended = true;
      await Promise.all(names.map((name) => sources[name].close(reason)));
    },
    info: {},
    control: () => {},
  };
}

/**
 * Every frame from every source, tagged, and every ending as a frame of its own.
 *
 * It closes once all of them have ended, and that close carries nothing: the endings already arrived as frames,
 * each one saying which source it belongs to.
 */
export function settled<T extends string, F, C>(
  sources: Record<T, Channel<F, C>>,
): Channel<Sourced<T, F> | Ended<T, C>, void> {
  const names = Object.keys(sources) as T[];
  const readers = new Set<(frame: Sourced<T, F> | Ended<T, C>) => void>();
  const closers = new Set<(reason: void) => void>();
  const failers = new Set<(error: unknown) => void>();
  let remaining = names.length;
  let ended = false;

  const emit = (frame: Sourced<T, F> | Ended<T, C>): void => {
    for (const reader of [...readers]) reader(frame);
  };

  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const closer of [...closers]) closer(undefined);
  };

  for (const name of names) {
    const source = sources[name];
    source.onFrame((frame) => emit({ source: name, frame }));
    source.onClose((ending) => {
      emit({ source: name, ending });
      remaining -= 1;
      if (remaining === 0) end();
    });
    source.onError((error) => {
      for (const failer of [...failers]) failer(error);
    });
  }

  return {
    send: () => Promise.reject(sendRefusal(names)),
    onFrame(handler) {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    onClose(handler) {
      if (ended) {
        handler(undefined);
        return () => {};
      }
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
    async close(reason?: string) {
      ended = true;
      await Promise.all(names.map((name) => sources[name].close(reason)));
    },
    info: {},
    control: () => {},
  };
}
