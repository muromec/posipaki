// ── an authoritative actor ──────────────────────────────────────────────────
//
// Run:  bun test src/record.test.ts
//
// What is proven is the shape: the state is the fold, a write comes back through the log, an accept follows the
// state, a refusal writes nothing, and `diff` names the record that moved it.

import { afterEach, describe, expect, it } from 'vitest';

import { counterSpec, type Counter, type CounterAsk, type CounterRecord } from './counter';
import { logChannel } from './log';
import { type RecordOutMessage } from './interface';
import { makeDurableActor } from './record';

const counter = makeDurableActor(counterSpec);

type Proc = Awaited<ReturnType<typeof counter.spawn>>;

const sealed: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const shut of sealed.reverse()) await shut();
  sealed.length = 0;
});

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 3000; waited += 10) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} did not happen`);
}

/** A process over a log holding what it was given, up and folded. */
async function running(
  initial: CounterRecord[] = [],
): Promise<{ log: ReturnType<typeof logChannel<CounterRecord>>; proc: Proc }> {
  const log = logChannel<CounterRecord>(initial);
  const proc = await counter.spawn({ source: log }, { name: 'counter' });
  await proc.ready();
  sealed.push(async () => {
    proc.send({ type: 'STOP' });
    await proc.wait();
  });
  if (initial.length > 0) await until(() => proc.state?.state != null, 'the first fold');
  return { log, proc };
}

function said(proc: Proc): Promise<RecordOutMessage> {
  return new Promise<RecordOutMessage>((resolve) => {
    const stop = proc.subscribe('message', (message) => {
      stop();
      resolve(message as RecordOutMessage);
    });
  });
}

describe('an authoritative actor', () => {
  it('is the fold of what the log already holds', async () => {
    const { proc } = await running([
      { type: 'ADD', by: 'me', n: 2 },
      { type: 'ADD', by: 'me', n: 3 },
    ]);
    expect(proc.state?.state).toEqual({ total: 5, added: 2, by: 'me' });
  });

  it('accepts a request once its record has come back, and the state holds it', async () => {
    const { proc } = await running([{ type: 'ADD', by: 'me', n: 1 }]);
    const answered = said(proc);
    proc.send({ type: 'ADD_RECORD', requestId: 'r-1', request: { n: 4, by: 'me' } });
    expect(await answered).toEqual({ type: 'RECORD_ACCEPTED', requestId: 'r-1' });
    // The accept is sent after the fold, so the state it was accepted for is already the process's.
    expect(proc.state?.state).toEqual({ total: 5, added: 2, by: 'me' });
  });

  it('refuses what the rules refuse, and writes nothing', async () => {
    const { log, proc } = await running([{ type: 'ADD', by: 'me', n: 1 }]);
    const answered = said(proc);
    proc.send({ type: 'ADD_RECORD', requestId: 'r-2', request: { n: -2, by: 'me' } });
    expect(await answered).toEqual({
      type: 'RECORD_REJECTED',
      requestId: 'r-2',
      reason: '1 and -2 is below zero',
    });
    // The log is untouched: a refusal is a word, not a record.
    expect(log.info['records']).toBe(1);
  });

  it('folds a record written from outside, and answers nobody', async () => {
    const { log, proc } = await running([{ type: 'ADD', by: 'me', n: 1 }]);
    const seen: RecordOutMessage[] = [];
    const stop = proc.subscribe('message', (message) => seen.push(message as RecordOutMessage));
    sealed.push(stop);
    await log.send({ type: 'ADD', by: 'somebody else', n: 10 });
    await until(() => proc.state?.state?.total === 11, 'the outside record');
    expect(seen).toEqual([]);
  });

  it('diffs two states back into the record that made the second', () => {
    const before: Counter = { total: 1, added: 1, by: 'me' };
    const after: Counter = { total: 5, added: 2, by: 'you' };
    expect(counterSpec.diff(before, after)).toEqual({ type: 'ADD', by: 'you', n: 4 });
    // From no state at all: the counter whole, because that is what a follower arriving is told.
    expect(counterSpec.diff(null, before)).toEqual({ type: 'COUNTED', by: 'me', total: 1, added: 1 });
  });

  it('goes down when the last watcher leaves', async () => {
    const { proc } = await running();
    proc.send({ type: 'ATTACH' });
    await until(() => (proc.state?.watching ?? 0) === 1, 'the watcher');
    proc.send({ type: 'DETACH' });
    await proc.wait();
  });
});
