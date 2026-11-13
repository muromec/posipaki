// ── one interface, two processes ────────────────────────────────────────────
//
// Run:  bun test src/interface.test.ts
//
// The authority owns the log and a proxy follows it, and a caller is given neither: it is given a `RecordHandle`,
// asks the same question, and gets the same shape of answer.  The compile-time half is the assignment below —
// both process types go into the same parameter — and the run-time half is one client run against both.

import { afterEach, describe, expect, it } from 'vitest';

import { counterSpec, type Counter, type CounterAsk, type CounterRecord } from './counter';
import { openLog } from './log';
import { mirrorChannel } from './mirror';
import { makeDurableProxyActor } from './proxy';
import { makeDurableActor, type RecordHandle, type RecordOutMessage } from './record';

const counter = makeDurableActor(counterSpec);
const follower = makeDurableProxyActor(counterSpec);

type AuthorityProc = Awaited<ReturnType<typeof counter.spawn>>;
type ProxyProc = Awaited<ReturnType<typeof follower.spawn>>;
type Handle = RecordHandle<Counter, CounterAsk, string>;

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

/** A caller that does not know which process it was given: ask once, and answer with the fold. */
async function ask(
  handle: Handle,
  requestId: string,
  n: number,
): Promise<{ answer: RecordOutMessage; total: number | null }> {
  const answered = new Promise<RecordOutMessage>((resolve) => {
    const stop = handle.subscribe('message', (message) => {
      if (message.requestId !== requestId) return;
      stop();
      resolve(message);
    });
  });
  handle.send({ type: 'ASK', requestId, request: { n, by: 'a caller' } });
  const answer = await answered;
  return { answer, total: handle.state?.state?.total ?? null };
}

/** The same value, whether it is an authority or a proxy: this is the claim the type system checks. */
function asHandle(proc: AuthorityProc | ProxyProc): Handle {
  return proc;
}

async function world(): Promise<{ authority: AuthorityProc; proxy: ProxyProc }> {
  const log = openLog<CounterRecord>([{ type: 'ADD', by: 'me', n: 1 }]);
  const authority = await counter.spawn({ source: log.channel() }, { name: 'authority' });
  await authority.ready();
  sealed.push(async () => {
    authority.send({ type: 'STOP' });
    await authority.wait();
  });
  const proxyProc = await follower.spawn(
    {
      authority,
      snapshot: authority.state?.state ?? null,
      source: mirrorChannel(authority, counterSpec),
    },
    { name: 'proxy' },
  );
  sealed.push(async () => {
    proxyProc.send({ type: 'STOP' });
    await proxyProc.wait();
  });
  await until(() => proxyProc.state?.state != null, 'the proxy to fold');
  return { authority, proxy: proxyProc };
}

describe('an authority and a proxy', () => {
  it('are both a RecordHandle: the same requests, the same answers, the same published state', async () => {
    const { authority, proxy: proxyProc } = await world();
    for (const proc of [authority, proxyProc]) {
      const handle = asHandle(proc);
      expect(handle.state?.state?.total).toBe(1);
    }
  });

  it('answer one client the same way, whichever it was given', async () => {
    const { authority, proxy: proxyProc } = await world();
    const throughAuthority = await ask(asHandle(authority), 'r-1', 4);
    const throughProxy = await ask(asHandle(proxyProc), 'r-2', 4);
    expect(throughAuthority.answer).toEqual({ type: 'ACCEPTED', requestId: 'r-1' });
    expect(throughProxy.answer).toEqual({ type: 'ACCEPTED', requestId: 'r-2' });
    expect(throughAuthority.total).toBe(5);
    expect(throughProxy.total).toBe(9);
  });

  it('relay a refusal the same way, in the spec’s own words', async () => {
    const { authority, proxy: proxyProc } = await world();
    const refused = await ask(asHandle(proxyProc), 'r-3', -5);
    expect(refused.answer).toEqual({
      type: 'REJECTED',
      requestId: 'r-3',
      reason: '1 and -5 is below zero',
    });
    expect(refused.total).toBe(1);
    expect(authority.state?.state?.total).toBe(1);
  });
});
