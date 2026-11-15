// ── one file, both ways ─────────────────────────────────────────────────────
//
// Run:  bun test src/ports/file/file.test.ts
//
// A real file on a temporary directory.  What is proven: what the file already holds is read on the first
// subscription, a write comes back to the same reader, and a read takes only what it has not taken before.

import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fileChannel } from './file.js';

const opened: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const shut of opened.reverse()) await shut();
  opened.length = 0;
});

const decoder = new TextDecoder();

/** A file holding what it was given, and a channel over it. */
async function file(held = ''): Promise<{ path: string; channel: ReturnType<typeof fileChannel> }> {
  const dir = await mkdtemp(join(tmpdir(), 'file-'));
  const path = join(dir, 'j.txt');
  await writeFile(path, held);
  const channel = fileChannel(path);
  opened.push(async () => {
    await channel.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { path, channel };
}

function until(condition: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let waited = 0;
    const tick = (): void => {
      if (condition()) return resolve();
      waited += 10;
      if (waited > 3000) return reject(new Error(`${what} did not happen`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('a file as a channel', () => {
  it('hands over what the file already holds', async () => {
    const { channel } = await file('first\nsecond\n');
    const seen: string[] = [];
    channel.onFrame((bytes) => seen.push(decoder.decode(bytes)));
    await until(() => seen.length === 1, 'the framed file');
    expect(seen.join('')).toBe('first\nsecond\n');
  });

  it('reads only what it has not read: a second frame is the second write', async () => {
    const { channel } = await file('one');
    const seen: string[] = [];
    channel.onFrame((bytes) => seen.push(decoder.decode(bytes)));
    await until(() => seen.length === 1, 'the file it found');

    await channel.send(new TextEncoder().encode(' two'));
    await until(() => seen.length === 2, 'what was sent');
    expect(seen).toEqual(['one', ' two']);
  });

  it('wakes every channel on the same path', async () => {
    const { path, channel } = await file('one');
    const other = fileChannel(path);
    opened.push(() => other.close());
    const here: string[] = [];
    const there: string[] = [];
    channel.onFrame((bytes) => here.push(decoder.decode(bytes)));
    other.onFrame((bytes) => there.push(decoder.decode(bytes)));
    await until(
      () => here.length === 1 && there.length === 1,
      'both channels reading what the file holds',
    );

    await channel.send(new TextEncoder().encode(' two'));
    await until(() => there.length === 2, 'the other channel hearing the write');
    expect(there.join('')).toBe('one two');
  });
});

describe("a file, asked whether it has more", () => {
  it("says what it holds past the cursor, and answers again when it grows", async () => {
    const { path, channel } = await file("first");
    const frames: string[] = [];
    channel.onFrame((bytes) => frames.push(decoder.decode(bytes)));

    // Either the bytes are there or the read for them is running: both mean a frame is coming.
    expect(await channel.hasFrames()).toBe(true);
    await until(() => frames.length === 1, "the first frame");
    expect(frames).toEqual(["first"]);
    // Nothing past the cursor and nothing being fetched — the file has been handed over.
    expect(await channel.hasFrames()).toBe(false);

    // Written around the channel, which is what another process does: the length is still the truth.
    await appendFile(path, "second");
    expect(await channel.hasFrames()).toBe(true);
  });
});
