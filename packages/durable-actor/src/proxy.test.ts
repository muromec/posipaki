// ── one authority, two proxies ──────────────────────────────────────────────
//
// Run:  bun test src/proxy.test.ts
//
// The shape a peer-to-peer task needs: one process owns the log and filters, two others follow it and take
// requests on its behalf.  The records a follower reduces are the authority's — it says which record explains
// each change (`diff`), and the proxy reduces that, so both sides run one fold from one description.

import { afterEach, describe, expect, it } from 'vitest';

import { counterSpec, type Counter, type CounterAsk, type CounterRecord } from './counter';
import { openLog } from './log';
import { mirrorChannel } from './mirror';
import { makeDurableProxyActor } from './proxy';
import { makeDurableActor, type RecordOutMessage } from './record';

const counter = makeDurableActor(counterSpec);
const follower = makeDurableProxyActor(counterSpec);
const optimistic = makeDurableProxyActor(counterSpec, { mode: 'optimistic' });

type AuthorityProc = Awaited<ReturnType<typeof counter.spawn>>;
type ProxyProc = Awaited<ReturnType<typeof follower.spawn>>;
type AnyProc = AuthorityProc | ProxyProc;

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

function said(proc: AnyProc, requestId: string): Promise<RecordOutMessage> {
  return new Promise<RecordOutMessage>((resolve) => {
    const stop = proc.subscribe('message', (message) => {
      if (message.requestId !== requestId) return;
      stop();
      resolve(message as RecordOutMessage);
    });
  });
}

interface World {
  authority: AuthorityProc;
  a: ProxyProc;
  b: ProxyProc;
  told: Record<string, CounterRecord[]>;
}

/** One log, one writer, two followers: the arrangement this test is about. */
async function world(): Promise<World> {
  const log = openLog<CounterRecord>([{ type: 'ADD', by: 'me', n: 1 }]);
  const authority = await counter.spawn({ source: log.channel() }, { name: 'authority' });
  await authority.ready();
  sealed.push(async () => {
    authority.send({ type: 'STOP' });
    await authority.wait();
  });

  const told: Record<string, CounterRecord[]> = { a: [], b: [] };
  const mirrorA = mirrorChannel(authority, counterSpec);
  const mirrorB = mirrorChannel(authority, counterSpec);
  mirrorA.onFrame((record) => told.a?.push(record));
  mirrorB.onFrame((record) => told.b?.push(record));

  const snapshot = authority.state?.state ?? null;
  const a = await follower.spawn({ authority, snapshot, source: mirrorA }, { name: 'proxy-a' });
  const b = await follower.spawn({ authority, snapshot, source: mirrorB }, { name: 'proxy-b' });
  for (const proc of [a, b]) {
    sealed.push(async () => {
      proc.send({ type: 'STOP' });
      await proc.wait();
    });
  }
  await until(() => a.state?.state != null && b.state?.state != null, 'both followers folded');
  return { authority, a, b, told };
}

describe('one authority, two proxies', () => {
  it('starts both followers on the authority fold, and the mirrors have said nothing yet', async () => {
    const { authority, a, b, told } = await world();
    expect(a.state?.state).toEqual({ total: 1, added: 1, by: 'me' });
    expect(b.state?.state).toEqual({ total: 1, added: 1, by: 'me' });
    expect(authority.state?.state).toEqual({ total: 1, added: 1, by: 'me' });
    // A snapshot is a state, not a record: nothing has changed, so no record has been sent.
    expect(told.a).toEqual([]);
  });

  it('takes a request from the first proxy, and both followers see it', async () => {
    const { authority, a, b, told } = await world();
    const answered = said(a, 'from-a');
    a.send({ type: 'ASK', requestId: 'from-a', request: { n: 4, by: 'caller-a' } });
    // The proxy answers under the caller's own id, not the one it asked the authority with.
    expect(await answered).toEqual({ type: 'ACCEPTED', requestId: 'from-a' });
    await until(() => b.state?.state?.total === 5, 'the second follower to catch up');
    expect(authority.state?.state).toEqual({ total: 5, added: 2, by: 'caller-a' });
    expect(b.state?.state).toEqual({ total: 5, added: 2, by: 'caller-a' });
    // Both were told the same record for the change, and it is the record the authority applied.
    expect(told.a?.[(told.a?.length ?? 0) - 1]).toEqual({ type: 'ADD', by: 'caller-a', n: 4 });
    expect(told.b?.[(told.b?.length ?? 0) - 1]).toEqual({ type: 'ADD', by: 'caller-a', n: 4 });
  });

  it('relays the authority refusal, and nothing is written', async () => {
    const { authority, a, b, told } = await world();
    const answered = said(a, 'too-much');
    a.send({ type: 'ASK', requestId: 'too-much', request: { n: -5, by: 'caller-a' } });
    expect(await answered).toEqual({
      type: 'REJECTED',
      requestId: 'too-much',
      reason: '1 and -5 is below zero',
    });
    expect(authority.state?.state?.total).toBe(1);
    expect(a.state?.state?.total).toBe(1);
    expect(b.state?.state?.total).toBe(1);
    // A refusal is not a record: nobody was told anything.
    expect(told.a).toHaveLength(0);
  });

  it('shows an optimistic guess at once, and keeps it when the authority takes it', async () => {
    const { authority } = await world();
    const mirror = mirrorChannel(authority, counterSpec);
    const guesser = await optimistic.spawn(
      { authority, snapshot: authority.state?.state ?? null, source: mirror },
      { name: 'guesser' },
    );
    sealed.push(async () => {
      guesser.send({ type: 'STOP' });
      await guesser.wait();
    });
    const answered = said(guesser, 'optimistic-1');
    guesser.send({ type: 'ASK', requestId: 'optimistic-1', request: { n: 3, by: 'caller' } });
    // The answer arrives before the authority has written anything: the guesser reduced it itself.
    expect(await answered).toEqual({ type: 'ACCEPTED', requestId: 'optimistic-1' });
    expect(guesser.state?.state?.total).toBe(4);
    await until(() => authority.state?.state?.total === 4, 'the authority');
    expect(guesser.state?.state?.total).toBe(4);
  });

  it('rolls an optimistic guess back when the authority refuses it', async () => {
    const { authority } = await world();
    const mirror = mirrorChannel(authority, counterSpec);
    const guesser = await optimistic.spawn(
      { authority, snapshot: authority.state?.state ?? null, source: mirror },
      { name: 'guesser' },
    );
    sealed.push(async () => {
      guesser.send({ type: 'STOP' });
      await guesser.wait();
    });
    const first = said(guesser, 'optimistic-1');
    guesser.send({ type: 'ASK', requestId: 'optimistic-1', request: { n: 3, by: 'caller' } });
    expect(await first).toEqual({ type: 'ACCEPTED', requestId: 'optimistic-1' });
    // The authority takes that one, then refuses a second that the guiltless proxy would never have shown.
    await until(() => authority.state?.state?.total === 4, 'the authority');
    await until(() => guesser.state?.state?.total === 4, 'the guesser');
    // A guess the authority refuses: the state goes back and the caller is told it was only a guess.
    const told = said(guesser, 'optimistic-2');
    guesser.send({ type: 'ASK', requestId: 'optimistic-2', request: { n: -10, by: 'caller' } });
    expect(await told).toEqual({
      type: 'REJECTED',
      requestId: 'optimistic-2',
      reason: '4 and -10 is below zero',
    });
  });
});
