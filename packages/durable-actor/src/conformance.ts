// ── the laws a spec has to pass ─────────────────────────────────────────────
//
// The four words are not four unrelated functions, so a spec that has them is not automatically a spec that means
// anything.  These are the laws, and they are exported as data rather than as a test file: a runner may be
// vitest, node:test, a loop in a script, or a page that draws a tick per law.
//
// Everything here is a function of a `LawCase`: the spec, a journal to fold, one request it allows and one it
// refuses.  Nothing reaches for a clock, a socket or a fixture.

import type { RecordSpec } from './record';

/** What the laws are checked against. */
export interface LawCase<S, R, Q, E = string> {
  /** What to call this spec in a failure: "a counter", "a ticket". */
  name: string;
  spec: RecordSpec<S, R, Q, E>;
  /** Records, in the order they happened.  The fold of these is the state every law is checked against. */
  journal: R[];
  /** A request the rules allow. */
  allowed: Q;
  /** A request the rules refuse. */
  refused: Q;
}

/** The laws, by the name a failure reports. */
export type LawName = 'fold' | 'diff' | 'map' | 'refusal' | 'effect';

export const LAWS: readonly LawName[] = ['fold', 'diff', 'map', 'refusal', 'effect'];

/** What one law has to say when a spec fails it. */
export interface LawFailure {
  law: LawName;
  message: string;
}

/** Every state the journal passes through: `states[i]` is what the first `i` records fold to. */
function walked<S, R, Q, E>(one: LawCase<S, R, Q, E>): (S | null)[] {
  const states: (S | null)[] = [null];
  for (const record of one.journal)
    states.push(one.spec.reduce(states[states.length - 1] ?? null, record));
  return states;
}

/** The state the journal folds to, or a failure when it folds to nothing. */
function folded<S, R, Q, E>(one: LawCase<S, R, Q, E>): S | null {
  const states = walked(one);
  return states[states.length - 1] ?? null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** One law, checked.  An empty array is a pass. */
export function runLaw<S, R, Q, E>(law: LawName, one: LawCase<S, R, Q, E>): LawFailure[] {
  const fail = (message: string): LawFailure[] => [{ law, message }];
  switch (law) {
    case 'fold': {
      // The fold is a function of the records and nothing else: taken twice, it is the same.
      const once = walked(one);
      const twice = walked(one);
      return same(once, twice)
        ? []
        : fail(`${one.name}: folding the same journal twice gave two states`);
    }
    case 'diff': {
      const states = walked(one);
      for (let at = 0; at < one.journal.length; at += 1) {
        const back = one.spec.diff(states[at] ?? null, states[at + 1] as S);
        if (!same(back, one.journal[at])) {
          return fail(
            `${one.name}: diff did not recover record ${at}: ${JSON.stringify(back)} for ${JSON.stringify(one.journal[at])}`,
          );
        }
      }
      return [];
    }
    case 'map': {
      const state = folded(one);
      if (state === null) return fail(`${one.name}: the journal folded to nothing`);
      const verdict = one.spec.filter(state, one.allowed);
      if (!('pass' in verdict)) return fail(`${one.name}: the allowed request was refused`);
      const once = one.spec.map(state, one.allowed);
      return same(once, one.spec.map(state, one.allowed))
        ? []
        : fail(`${one.name}: map gave two records for one request`);
    }
    case 'refusal': {
      const state = folded(one);
      if (state === null) return fail(`${one.name}: the journal folded to nothing`);
      const verdict = one.spec.filter(state, one.refused);
      if (!('refuse' in verdict)) return fail(`${one.name}: the refused request passed the filter`);
      // A refusal is a word: the journal, and the state it folds to, are untouched.
      return same(walked(one), walked(one)) ? [] : fail(`${one.name}: a refusal changed the fold`);
    }
    case 'effect': {
      const state = folded(one);
      if (state === null) return fail(`${one.name}: the journal folded to nothing`);
      const verdict = one.spec.filter(state, one.allowed);
      if (!('pass' in verdict)) return fail(`${one.name}: the allowed request was refused`);
      const record = one.spec.map(state, one.allowed);
      const after = one.spec.reduce(state, record);
      if (same(after, state))
        return fail(`${one.name}: an allowed request left the state where it was`);
      return same(one.spec.diff(state, after), record)
        ? []
        : fail(`${one.name}: diff does not name the record that moved the state`);
    }
  }
}

/** Every law, checked.  An empty array is a clean spec. */
export function runLaws<S, R, Q, E>(one: LawCase<S, R, Q, E>): LawFailure[] {
  return LAWS.flatMap((law) => runLaw(law, one));
}

/**
 * Register the laws with whatever runner you have.
 *
 * It takes the registrar rather than importing a test framework, so the suite is the same in vitest, in
 * node:test, or in a page:
 *
 *     conformance(ticketCase, (name, run) => it(name, run));
 *
 * Each `run` throws with the law's sentence when the spec fails it.
 */
export function conformance<S, R, Q, E>(
  one: LawCase<S, R, Q, E>,
  register: (name: string, run: () => void) => void,
): void {
  for (const law of LAWS) {
    register(`${one.name}: ${law}`, () => {
      const failures = runLaw(law, one);
      for (const failure of failures) throw new Error(failure.message);
    });
  }
}
