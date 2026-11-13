// ── a counter, as a record spec ─────────────────────────────────────────────
//
// The smallest state a fold can have: records add, requests ask to add, and a negative total is refused.  It is
// here rather than in each test because two of them need it, and a spec is the thing under test, not scenery.
//
// The state carries two things a fold of bare numbers would not: `by`, the last writer, because `diff` has to
// name who added; and `added`, the number of records, which is state here and not log metadata — a follower is
// given the fold as a snapshot, so everything the state holds survives an attach, this included.

import type { FilterResult, RecordSpec } from './interface';

export interface Counter {
  total: number;
  /** How many records made it.  A fact the state keeps, so a snapshot carries it. */
  added: number;
  /** Who wrote the record that last moved it.  Kept for `diff`, not for a reader. */
  by: string;
}

export type CounterRecord = { type: 'ADD'; by: string; n: number };
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
    if (state === null) return { total: record.n, added: 1, by: record.by };
    return { total: state.total + record.n, added: state.added + 1, by: record.by };
  },

  diff(before: Counter | null, after: Counter): CounterRecord {
    return { type: 'ADD', by: after.by, n: after.total - (before?.total ?? 0) };
  },
};
