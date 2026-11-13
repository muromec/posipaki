// ── the laws, run against the specs in this package ─────────────────────────
//
// Run:  bun test src/conformance.test.ts
//
// The laws themselves live in `conformance.ts`; this file only says what to run them against.  A spec that is not
// here is not a spec that passes — it is a spec nobody checked.

import { describe, it } from 'vitest';

import { conformance, type LawCase } from './conformance';
import { counterSpec, type Counter, type CounterAsk, type CounterRecord } from './counter';
import { ticketSpec, type Ticket, type TicketAsk, type TicketRecord } from '../examples/ticket';

const counterCase: LawCase<Counter, CounterRecord, CounterAsk> = {
  name: 'a counter',
  spec: counterSpec,
  journal: [
    { type: 'ADD', by: 'me', n: 1 },
    { type: 'ADD', by: 'you', n: 4 },
  ],
  allowed: { n: 2, by: 'somebody' },
  refused: { n: -9, by: 'somebody' },
};

const ticketCase: LawCase<Ticket, TicketRecord, TicketAsk> = {
  name: 'a ticket',
  spec: ticketSpec,
  journal: [
    {
      type: 'TASK_OPENED',
      id: 't-1',
      at: '2026-11-13T10:00:00.000Z',
      owner: 'butler',
      by: 'peer:alice',
      text: 'write me a thing',
    },
    { type: 'TASK_MOVED', at: '2026-11-13T10:01:00.000Z', by: 'butler', state: 'WORKING' },
  ],
  allowed: { type: 'COMMENT', by: 'butler', at: '2026-11-13T10:02:00.000Z', text: 'on it' },
  refused: { type: 'MOVE', by: 'swat', at: '2026-11-13T10:03:00.000Z', state: 'COMPLETED' },
};

describe('the laws', () => {
  conformance(counterCase, (name, run) => it(name, run));
  conformance(ticketCase, (name, run) => it(name, run));
});
