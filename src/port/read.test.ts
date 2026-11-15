// ── reading one frame, and not losing the one behind it ───────────────────

import { describe, expect, it } from 'vitest';
import { memoryChannelPair } from "./index.js";

import type { Channel } from "./channel.js";
import { readMessage, readMessageMaybe } from "./read.js";

/** Let the pair deliver: a memory channel hands frames on in a later turn, never inside `send`. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('one message at a time', () => {
  it('takes a frame that arrives after the read starts', async () => {
    const pair = memoryChannelPair<string>();
    const read = readMessage(pair.near);

    await pair.far.send('first');

    expect(await read).toBe('first');
  });

  it('keeps the frame behind the one it handed out, for the next read', async () => {
    const pair = memoryChannelPair<string>();
    const read = readMessage(pair.near);
    await pair.far.send('one');
    await pair.far.send('two');

    expect(await read).toBe('one');
    expect(await readMessage(pair.near)).toBe('two');
  });

  it('hands the frames of one channel out in the order they arrived', async () => {
    const pair = memoryChannelPair<string>();
    const first = readMessage(pair.near);
    const second = readMessage(pair.near);

    await pair.far.send('a');
    await settled();
    await pair.far.send('b');

    expect(await first).toBe('a');
    expect(await second).toBe('b');
  });
});

describe('one message, or nothing', () => {
  it('answers `nothing` when the channel is quiet and can say so', async () => {
    const { near, far } = memoryChannelPair<string>();
    // A memory pair keeps nothing: nothing standing, nothing being fetched, and it can say so.
    expect(await readMessageMaybe(far)).toBeNull();
    expect(await readMessageMaybe(far, 'none')).toBe('none');
    await near.send('here');
    expect(await readMessageMaybe(far)).toBe('here');
  });

  it('waits on a channel that cannot say when it is quiet', async () => {
    const { near, far } = memoryChannelPair<string>();
    // A stream has no end to reach: `hasFrames` answers null, so the question waits for a frame instead of
    // answering "nothing" about a future it cannot see.
    const silent: Channel<string, string> = { ...far, hasFrames: async () => null };
    const waiting = readMessageMaybe(silent, 'none');
    await near.send('later');
    expect(await waiting).toBe('later');
  });
});
