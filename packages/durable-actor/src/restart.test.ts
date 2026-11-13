// ── a restart is a fold of the same log ─────────────────────────────────────
//
// Run:  bun test src/restart.test.ts
//
// Three processes, a few changes through messages, then all three stop and come back from the log alone.  What is
// proven is the promise the design makes about durability: the state is the fold, so a restart that reads the
// same records reads the same state.

import { afterEach, describe, expect, it } from 'vitest';

import { counterSpec, type CounterAsk, type CounterRecord } from './counter';
import { openLog } from './log';
import { mirrorChannel } from './mirror';
import { makeDurableProxyActor } from './proxy';
import { type RecordOutMessage } from './interface';
import { makeDurableActor } from './record';

const counter = makeDurableActor(counterSpec);
const follower = makeDurableProxyActor(counterSpec);

type AuthorityProc = Awaited<ReturnType<typeof counter.spawn>>;
type ProxyProc = Awaited<ReturnType<typeof follower.spawn>>;
type Log = ReturnType<typeof openLog<CounterRecord>>;

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

function said(proc: AuthorityProc | ProxyProc, requestId: string): Promise<RecordOutMessage> {
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
}

/** The three processes, over a log that is given to them: the log is the thing that survives. */
async function spawnAll(log: Log): Promise<World> {
  const authority = await counter.spawn({ source: log.channel() }, { name: 'authority' });
  await authority.ready();
  const a = await follower.spawn(
    { upstream: authority, source: mirrorChannel(authority, counterSpec) },
    { name: 'proxy-a' },
  );
  const b = await follower.spawn(
    { upstream: authority, source: mirrorChannel(authority, counterSpec) },
    { name: 'proxy-b' },
  );
  const world = { authority, a, b };
  sealed.push(() => stopAll(world));
  await until(
    () => a.state?.state != null && b.state?.state != null && authority.state?.state != null,
    'all three folded',
  );
  return world;
}

async function stopAll(world: World): Promise<void> {
  for (const proc of [world.a, world.b, world.authority]) {
    proc.send({ type: 'STOP' });
    await proc.wait();
  }
}

describe('three actors, restarted from the log', () => {
  it('come back into the state they were in', async () => {
    const log = openLog<CounterRecord>([{ type: 'ADD', by: 'me', n: 1 }]);
    const before = await spawnAll(log);

    const first = said(before.a, 'r-1');
    before.a.send({ type: 'ADD_RECORD', requestId: 'r-1', request: { n: 4, by: 'caller-a' } });
    expect(await first).toEqual({ type: 'RECORD_ACCEPTED', requestId: 'r-1' });
    const second = said(before.b, 'r-2');
    before.b.send({ type: 'ADD_RECORD', requestId: 'r-2', request: { n: 2, by: 'caller-b' } });
    expect(await second).toEqual({ type: 'RECORD_ACCEPTED', requestId: 'r-2' });
    await until(() => before.a.state?.state?.total === 7, 'both followers caught up');

    const was = {
      authority: before.authority.state?.state,
      a: before.a.state?.state,
      b: before.b.state?.state,
    };
    expect(was.authority).toEqual({ total: 7, added: 3, by: 'caller-b' });

    // All three stop; only the log is left.
    await stopAll(before);

    // And come back over the same log.
    const after = await spawnAll(log);
    expect(after.authority.state?.state).toEqual(was.authority);
    expect(after.a.state?.state).toEqual(was.a);
    expect(after.b.state?.state).toEqual(was.b);
  });

  it('keep writing to the same log after a restart', async () => {
    const log = openLog<CounterRecord>([{ type: 'ADD', by: 'me', n: 1 }]);
    const first = await spawnAll(log);
    const opening = said(first.a, 'r-1');
    first.a.send({ type: 'ADD_RECORD', requestId: 'r-1', request: { n: 1, by: 'caller-a' } });
    expect(await opening).toEqual({ type: 'RECORD_ACCEPTED', requestId: 'r-1' });
    await stopAll(first);

    const second = await spawnAll(log);
    expect(second.authority.state?.state?.total).toBe(2);
    const next = said(second.b, 'r-2');
    second.b.send({ type: 'ADD_RECORD', requestId: 'r-2', request: { n: 3, by: 'caller-b' } });
    expect(await next).toEqual({ type: 'RECORD_ACCEPTED', requestId: 'r-2' });
    await until(() => second.a.state?.state?.total === 5, 'the other follower');
    // The log holds every record that ever moved it: two before the restart, one after.
    const records: CounterRecord[] = [];
    log.channel().onFrame((record) => records.push(record));
    expect(records).toEqual([
      { type: 'ADD', by: 'me', n: 1 },
      { type: 'ADD', by: 'caller-a', n: 1 },
      { type: 'ADD', by: 'caller-b', n: 3 },
    ]);
  });
});
