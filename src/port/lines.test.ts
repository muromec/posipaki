// ── octets, as lines ────────────────────────────────────────────────────────
//
// Run:  bun test src/ports/lines/lines.test.ts
//
// What is proven: a line is handed over once its newline has arrived, and a character cut in two by a read
// still decodes as one character.

import { describe, expect, it } from 'vitest';

import { linesChannel } from "./lines.js";
import { encode, incoming, recording } from "./testing.js";

describe('octets as lines', () => {
  it('hands over a line once its newline has arrived', () => {
    const { inbound, write } = incoming();
    const lines: string[] = [];
    linesChannel(inbound).onFrame((line) => lines.push(line));

    write('half');
    expect(lines).toEqual([]);
    write(' a line\nsecond\npar');
    expect(lines).toEqual(['half a line', 'second']);
  });

  it('keeps a character whole when a read cuts it in two', () => {
    const { inbound, bytes } = incoming();
    const lines: string[] = [];
    linesChannel(inbound).onFrame((line) => lines.push(line));

    const cafe = encode('café\n');
    bytes(cafe.subarray(0, 4));
    bytes(cafe.subarray(4));
    expect(lines).toEqual(['café']);
  });

  it('sends a line as its octets and a newline', async () => {
    const { out, written } = recording();
    await linesChannel(out).send('one');
    expect(written.frames).toEqual(['one\n']);
  });
});
