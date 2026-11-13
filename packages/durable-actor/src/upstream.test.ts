// ── the two forms a follower sends through ──────────────────────────────────
//
// Run:  bun test src/upstream.test.ts
//
// A request answers and a channel does not, and that is the whole difference.  A process is the shortcut: a call
// when the mode has to know whether the authority took the request, a channel when it does not.

import { describe, expect, it } from 'vitest';

import type { RecordInMessage, RecordOutMessage } from './interface';
import { Refused, processOf, requesting, upstreamOf } from './upstream';

type Ask = { n: number };

/** A process that answers every request the way an authority does: by the request, and under its own id. */
function authority() {
  const listeners = new Set<(message: RecordOutMessage) => void>();
  return {
    send(message: RecordInMessage<Ask>) {
      if (message.type !== 'ADD_RECORD') return;
      const answer: RecordOutMessage =
        message.request.n < 0
          ? { type: 'RECORD_REJECTED', requestId: message.requestId, reason: 'below zero' }
          : { type: 'RECORD_ACCEPTED', requestId: message.requestId };
      for (const listener of listeners) listener(answer);
    },
    subscribe(_event: 'message', handler: (message: RecordOutMessage) => void) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

describe('the form a follower works in', () => {
  it('makes a process a call for a guesser, and a channel for a follower that makes no guesses', () => {
    const to = authority();
    expect(typeof upstreamOf(to, 'optimistic')).toBe('function');
    const blind = upstreamOf(to, 'deferred');
    expect(typeof blind).not.toBe('function');
    expect(typeof (blind as { send: unknown }).send).toBe('function');
  });

  it('keeps the process it was made from, so a follower can still attach to what it asks', () => {
    const to = authority();
    expect(processOf(to)).toBe(to);
    // A call written by hand carries nothing: the authority's life is its caller's business.
    expect(processOf(async () => {})).toBeNull();
    expect(processOf(upstreamOf(to, 'deferred'))).toBeNull();
  });

  it('answers a call from the process, in that process’s own words', async () => {
    const ask = requesting(authority());
    await expect(ask({ n: 3 })).resolves.toBeUndefined();
    await expect(ask({ n: -3 })).rejects.toBeInstanceOf(Refused);
    await expect(ask({ n: -3 })).rejects.toMatchObject({ reason: 'below zero' });
  });
});
