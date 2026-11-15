import { describe, expect, it } from 'vitest';
import { memoryChannelPair, splitChannel } from "./index.js";
import type { Part } from "./index.js";

import { sseChannel, sseWriter } from "./sse.js";

/** A pair to write lines into, and the events it produces. */
async function events(lines: string[]): Promise<string[]> {
  const { near, far } = memoryChannelPair<Part>();
  const seen: string[] = [];
  const channel = sseChannel(far);
  channel.onFrame((event) => seen.push(event));
  for (const line of lines) await near.send({ line, bytes: null });
  await near.close('done');
  return seen;
}

describe('sse', () => {
  it('gives one value per event, and nothing for the transport fields', async () => {
    expect(
      await events([
        'event: task',
        'id: 4',
        'data: {"a":1}',
        '',
        ': a comment',
        'data: {"b":2}',
        '',
      ]),
    ).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('joins the data lines of one event, and drops an event that carries none', async () => {
    expect(await events(['data: one', 'data: two', '', 'event: ping', ''])).toEqual(['one\ntwo']);
  });

  it('flushes an event the peer ended without a blank line', async () => {
    expect(await events(['data: last'])).toEqual(['last']);
  });
});

describe('sse writer', () => {
  it('writes events a reader of the same vocabulary gets back, line for line', async () => {
    // The two adapters are inverses: what one writes into a body, the other reads out of it.
    const { near, far } = memoryChannelPair<Uint8Array>();
    const out = sseWriter(near);
    const back: string[] = [];
    const read = sseChannel(splitChannel(far));
    read.onFrame((event) => back.push(event));

    await out.send('{"a":1}');
    await out.send('one\ntwo');
    await out.close('done');

    expect(back).toEqual(['{"a":1}', 'one\ntwo']);
  });
});
