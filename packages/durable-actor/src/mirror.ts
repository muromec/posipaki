// ── records out of an authoritative state ───────────────────────────────────
//
// The channel a follower reads while it follows an authority.  Whoever is authoritative already reduced the
// record; `diff` is how it says which record that was, so the follower reduces the same thing the authority did
// instead of inventing one from a copy of the state.
//
// What it does not carry is a starting point: the fold as it stands is a state, and a follower is given it as one
// (`authority.state`), not squeezed through the record vocabulary.  A record is a change; a snapshot is not.

import type { Channel } from 'posipaki/port';

import { ChannelClosed } from './closed';

import type { RecordSpec } from './record';

/** What a mirror needs of the process it follows: a state, and the news that it moved. */
export interface Stateful<S> {
  readonly pname: string;
  readonly state: { state: S | null } | null;
  subscribe(event: 'state', handler: () => void): () => void;
}

/**
 * A channel of records, derived from an authority's state: one record per change, and nothing else.
 *
 * One subscription to the authority is shared by every reader of this channel, so two followers of one mirror
 * are told a change once.  `send` is refused, because the authority is the writer.
 */
export function mirrorChannel<S, R, Q, E>(
  authority: Stateful<S>,
  spec: RecordSpec<S, R, Q, E>,
): Channel<R, string> {
  const readers = new Set<(record: R) => void>();
  /** What the readers have been told so far: the last state this channel has spoken for. */
  let known: S | null = null;
  let watching: (() => void) | null = null;
  let ended: string | null = null;

  const emit = (record: R): void => {
    for (const reader of readers) reader(record);
  };

  /** One subscription, made when the first reader arrives and dropped when the last one leaves. */
  const follow = (): void => {
    if (watching !== null) return;
    known = authority.state?.state ?? null;
    watching = authority.subscribe('state', () => {
      const now = authority.state?.state ?? null;
      if (now === null || same(known, now)) return;
      const record = spec.diff(known, now);
      known = now;
      emit(record);
    });
  };

  const leave = (): void => {
    if (readers.size > 0 || watching === null) return;
    watching();
    watching = null;
  };

  return {
    async send(): Promise<void> {
      throw new ChannelClosed('this channel is the authority’s: it is written where the log is');
    },
    onFrame(handler) {
      readers.add(handler);
      follow();
      return () => {
        readers.delete(handler);
        leave();
      };
    },
    onClose: () => () => {},
    onError: () => () => {},
    close: async (reason = 'the mirror is closed') => {
      if (ended !== null) return;
      ended = reason;
      readers.clear();
      leave();
    },
    info: { authority: authority.pname },
    control: () => {},
  };
}

/** Whether the authority has said anything new: a state tick is not a record. */
function same<S>(before: S | null, after: S): boolean {
  return before !== null && JSON.stringify(before) === JSON.stringify(after);
}
