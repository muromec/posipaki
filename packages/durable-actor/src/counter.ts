// ── a counter, as a record spec ─────────────────────────────────────────────
//
// The smallest state a fold can have: records add, requests ask to add, and a negative total is refused.  It is
// here rather than in each test because two of them need it, and a spec is the thing under test, not scenery.
//
// Two record kinds, and the second is the interesting one: `COUNTED` states the counter whole.  A follower that
// arrives late is handed `diff(null, state)`, so a vocabulary that can only say "add three" cannot say where a
// counter already stands — and a spec whose state is ever read by somebody new needs a record that can.

import type { FilterResult, RecordSpec } from './interface';

export interface Counter {
  total: number;
  /** How many added records made it.  A fact the state keeps, so a whole state carries it. */
  added: number;
  /** Who wrote the record that last moved it.  Kept for `diff`, not for a reader. */
  by: string;
}

export type CounterRecord =
  | { type: 'ADD'; by: string; n: number }
  /** The counter as it stands: what a follower is told when it arrives. */
  | { type: 'COUNTED'; by: string; total: number; added: number };

export type CounterAsk = { n: number; by: string };

export const counterSpec: RecordSpec<Counter, CounterRecord, CounterAsk> = {
  filter(state: Counter, ask: CounterAsk): FilterResult {
    if (state.total + ask.n < 0) return { refuse: `${state.total} and ${ask.n} is below zero` };
    return { pass: true };
  },

  map(_state: Counter, ask: CounterAsk): CounterRecord {
    return { type: 'ADD', by: ask.by, n: ask.n };
  },

  reduce(state: Counter | null, record: CounterRecord): Counter {
    if (record.type === 'COUNTED') return { total: record.total, added: record.added, by: record.by };
    if (state === null) return { total: record.n, added: 1, by: record.by };
    return { total: state.total + record.n, added: state.added + 1, by: record.by };
  },

  diff(before: Counter | null, after: Counter): CounterRecord {
    // From nothing: the counter whole, or a follower could not start where it stands.
    if (before === null) {
      return { type: 'COUNTED', by: after.by, total: after.total, added: after.added };
    }
    return { type: 'ADD', by: after.by, n: after.total - before.total };
  },
};
