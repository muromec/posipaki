// ── the demo's wiring, without a browser ────────────────────────────────────
//
// Run:  bun test demo/chain.test.ts
//
// The demo draws three boards; this is the same chain of processes and channels, driven directly.  What is proven
// is what the page shows: a request anywhere reaches the log, both followers fold it, and a cut channel stops a
// board until it is healed and re-attached from the state it finds.

import { afterEach, describe, expect, it } from 'vitest';

import { mirrorChannel } from '../src/mirror';
import { openLog } from '../src/log';
import { makeDurableProxyActor } from '../src/proxy';
import { makeDurableActor } from '../src/record';
import { gateChannel } from './gate';
import { shapesSpec, type Board, type ShapesRecord } from './shapes';

const Authority = makeDurableActor(shapesSpec);
const Follower = makeDurableProxyActor(shapesSpec);
const Guesser = makeDurableProxyActor(shapesSpec, { mode: 'optimistic' });

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

/** A board as the page draws it: which box holds which shape. */
function drawn(board: Board | null | undefined): string[] {
  return (board?.cells ?? []).map((cell) =>
    cell === null ? '.' : cell[0],
  );
}

async function world() {
  // A board begins by being cleared: the log has no empty state, only a first record.
  const log = openLog<ShapesRecord>([{ type: 'CLEAR' }]);
  const a = await Authority.spawn({ source: log.channel() }, { name: 'board-a' });
  sealed.push(async () => {
    a.send({ type: 'STOP' });
    await a.wait();
  });
  const ab = gateChannel(mirrorChannel(a, shapesSpec));
  const b = await Follower.spawn(
    { upstream: a, source: ab.channel },
    { name: 'board-b' },
  );
  // A follower attaches to a state, so it is spawned once the process it follows has one.
  await until(() => b.state?.state != null, 'the deferred follower to fold');
  const bc = gateChannel(mirrorChannel(b, shapesSpec));
  const c = await Guesser.spawn(
    { upstream: b, source: bc.channel },
    { name: 'board-c' },
  );
  for (const proc of [b, c]) {
    sealed.push(async () => {
      proc.send({ type: 'STOP' });
      await proc.wait();
    });
  }
  return { log, a, b, c, ab, bc };
}

describe('three boards in a chain', () => {
  it('carries a request from the far end to the log, and back to every board', async () => {
    const { a, b, c } = await world();
    // A shape placed through the optimistic board: it shows at once, and the others follow when the log has it.
    c.send({
      type: 'ADD_RECORD',
      requestId: 'c-1',
      request: { cell: 0, shape: 'triangle' },
    });
    // The guess is reduced here a tick after the ask: the board shows it before the log has heard about it.
    await until(() => drawn(c.state?.state)[0] === 't', 'the optimistic board');
    await until(() => drawn(a.state?.state)[0] === 't', 'the log');
    await until(() => drawn(b.state?.state)[0] === 't', 'the deferred follower');
    expect(drawn(c.state?.state)).toEqual(drawn(a.state?.state));
  });

  it('stops the board behind a cut channel, and catches it up when the channel is healed', async () => {
    const { a, b, c, bc } = await world();
    bc.cut();
    const before = drawn(c.state?.state);
    a.send({
      type: 'ADD_RECORD',
      requestId: 'a-1',
      request: { cell: 1, shape: 'circle' },
    });
    await until(() => drawn(a.state?.state)[1] === 'c', 'the log');
    await until(() => drawn(b.state?.state)[1] === 'c', 'the deferred follower');
    // The cut one has heard nothing: a partition is not a pause.
    expect(drawn(c.state?.state)).toEqual(before);

    // Healed, it is re-attached from the state where it finds the board: a snapshot, then the changes.
    bc.heal();
    c.send({ type: 'STOP' });
    await c.wait();
    const again = await Guesser.spawn(
      { upstream: b, source: bc.channel },
      { name: 'board-c2' },
    );
    sealed.push(async () => {
      again.send({ type: 'STOP' });
      await again.wait();
    });
    expect(drawn(again.state?.state)).toEqual(drawn(b.state?.state));
  });

  it('refuses a shape in a box that is taken, and says where', async () => {
    const { a, c } = await world();
    a.send({
      type: 'ADD_RECORD',
      requestId: 'a-1',
      request: { cell: 2, shape: 'diamond' },
    });
    await until(() => drawn(c.state?.state)[2] === 'd', 'the far board');
    const heard: string[] = [];
    c.subscribe('message', (message) => {
      if (message.type === 'RECORD_REJECTED') heard.push(message.reason);
    });
    c.send({
      type: 'ADD_RECORD',
      requestId: 'c-2',
      request: { cell: 2, shape: 'circle' },
    });
    await until(() => heard.length > 0, 'the refusal');
    expect(heard[0]).toBe('box 2 is taken');
  });

  it('clears the board when a second shape of the same shape arrives', async () => {
    const { a } = await world();
    a.send({
      type: 'ADD_RECORD',
      requestId: 'a-1',
      request: { cell: 0, shape: 'triangle' },
    });
    await until(() => drawn(a.state?.state)[0] === 't', 'the first shape');
    a.send({
      type: 'ADD_RECORD',
      requestId: 'a-2',
      request: { cell: 3, shape: 'triangle' },
    });
    await until(() => drawn(a.state?.state).every((box) => box === '.'), 'the cleared board');
    expect(drawn(a.state?.state)).toEqual(['.', '.', '.', '.']);
  });
});
