// ── Message Matcher ──────────────────────────────────────────────────────
//
// Canonical form: `fn(msg, history) => boolean`.  `msg` is the just-arrived
// message (also the last element of `history`); `history` is the full
// accumulated list *including* `msg`.
//
// Two shortcuts:
//   - a message literal `{ type: "X" }`  → matches the latest message
//   - a list `[{...}, {...}]`            → matches the tail of history,
//                                           in order, from oldest to newest

import type { Message } from "../types.js";

export type Matcher<M extends Message> = (msg: M, history: M[]) => boolean;

export type MatchSpec<M extends Message> = Matcher<M> | Partial<M> | Array<Partial<M>>;

function shallowMatch<M extends Message>(msg: M, spec: Partial<M>): boolean {
  for (const key of Object.keys(spec) as Array<keyof M>) {
    if (msg[key] !== spec[key]) return false;
  }
  return true;
}

/** Convert a matcher spec to a canonical matcher function. */
export function toMatcher<M extends Message>(spec: MatchSpec<M>): Matcher<M> {
  if (typeof spec === "function") return spec as Matcher<M>;

  if (Array.isArray(spec)) {
    // Sequence: the tail of history must equal `spec`, in order.
    return (_msg, history) => {
      if (history.length < spec.length) return false;
      const tail = history.slice(-spec.length);
      return spec.every((s, i) => shallowMatch(tail[i], s));
    };
  }

  // Single literal: the latest message must shallow-match.
  return (msg) => shallowMatch(msg, spec);
}

/**
 * Occurrence matcher: matches when at least `n` messages in the history
 * satisfy `spec`.  This is the canonical form for "Nth occurrence" waits:
 *
 *   const c = createCollector<PongMsg>({ type: "PONG" });
 *   await c.next(times({ type: "PONG" }, 3));  // wait for the 3rd PONG
 *
 * Note: `history` accumulates, so this counts occurrences over the whole
 * collected history, not since the previous `next()`.  Use `reset()` with a
 * fresh collector for windowed counts.
 */
export function times<M extends Message>(spec: Partial<M> | Matcher<M>, n: number): Matcher<M> {
  const single: Matcher<M> = typeof spec === "function" ? spec : (m) => shallowMatch(m, spec);
  return (_msg, history) => history.filter((m) => single(m, history)).length >= n;
}
