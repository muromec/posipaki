// ── what a layer does with what it is given ───────────────────────────────
//
// The mapper is the whole subject: what goes down, what comes up, and what a skip leaves alone.  The medium
// is a memory pair, which is posipaki's own double.

import { describe, expect, it } from 'vitest';
import { memoryChannelPair } from "./memory.js";

import { mapChannel, SKIP } from "./map.js";

/** Let the pair deliver: a memory channel hands frames on in a later turn, never inside `send`. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('a channel of one vocabulary over another', () => {
  it('maps what is sent, and writes it to the channel below', async () => {
    const pair = memoryChannelPair<string>();
    const above = mapChannel<string, string, string>(
      pair.near,
      (value) => value.toUpperCase(),
      (value) => value,
    );
    const heard: string[] = [];
    pair.far.onFrame((frame) => heard.push(frame));

    await above.send('one');
    await settled();

    expect(heard).toEqual(['ONE']);
  });

  it('writes nothing for a value the mapper skips, and the send still resolves', async () => {
    const pair = memoryChannelPair<string>();
    const above = mapChannel<string, string, string>(
      pair.near,
      (value) => (value === 'nothing' ? SKIP : value),
      (value) => value,
    );
    const heard: string[] = [];
    pair.far.onFrame((frame) => heard.push(frame));

    await above.send('nothing');
    await above.send('something');
    await settled();

    expect(heard).toEqual(['something']);
  });

  it('maps what arrives, and drops an arrival its mapper skips', async () => {
    const pair = memoryChannelPair<string>();
    const above = mapChannel<string, string, string>(
      pair.near,
      (value) => value,
      (value) => (value.startsWith('x-') ? SKIP : `up:${value}`),
    );
    const heard: string[] = [];
    above.onFrame((frame) => heard.push(frame));

    await pair.far.send('x-hidden');
    await pair.far.send('shown');
    await settled();

    expect(heard).toEqual(['up:shown']);
  });

  it('forwards the ending the channel below reported', async () => {
    const pair = memoryChannelPair<string>();
    const above = mapChannel<string, string, string>(
      pair.near,
      (value) => value,
      (value) => value,
    );
    const endings: string[] = [];
    above.onClose((reason) => endings.push(reason));

    await pair.far.close('the peer left');
    await settled();

    expect(endings).toEqual(['the peer left']);
  });

  it('carries the medium’s own facts through, because the layer does not own them', () => {
    const pair = memoryChannelPair<string>();
    const above = mapChannel<string, string, string>(
      pair.near,
      (value) => value,
      (value) => value,
    );

    expect(above.info).toBe(pair.near.info);
  });
});
