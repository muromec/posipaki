// ── the whole composition ───────────────────────────────────────────────────
//
// `handshake(json1(split(bytes)))` on both ends of one pair of streams.  It is the test that the four pieces fit
// together: the frames are the seam's own, and `$chunk` is only a frame with octets after it.

import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { Channel } from "./channel.js";
import { handshake } from "./handshake.js";
import type { Delivered } from "./json1.js";
import { json1, readFrame } from "./json1.js";
import { announcedOctets } from "../remote/protocols/json1.js";
import { splitChannel } from "./split.js";
import { streamChannel } from "./stream.js";

const VERSION = "json.v1";
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Let the deferred write reach the other end. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The seam's own rule for how many octets follow a line, which the splitter is handed rather than knows. */
const announced = (line: string): number | null => announcedOctets(readFrame(line));

/** A stream that hands what is written to another stream on a later turn, which is what any medium does. */
function deferTo(target: PassThrough): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      setImmediate(() => target.write(chunk));
      done();
    },
  });
}

/** Two stream pairs crossed, each end seeing the whole stack above its own side. */
async function wire(): Promise<{ a: Channel<Delivered>; b: Channel<Delivered> }> {
  const toB = new PassThrough();
  const toA = new PassThrough();
  const a = streamChannel({ read: toA, write: deferTo(toB) });
  const b = streamChannel({ read: toB, write: deferTo(toA) });
  const [left, right] = await Promise.all([
    handshake(json1(splitChannel(a, announced)), { version: VERSION }),
    handshake(json1(splitChannel(b, announced)), { version: VERSION }),
  ]);
  return { a: left, b: right };
}

describe("a connection built out of the port's pieces", () => {
  it("agrees on a protocol, then carries a frame each way", async () => {
    const { a, b } = await wire();
    const heard: Delivered[] = [];
    a.onFrame((value) => heard.push(value));

    await b.send({ frame: { $msg: { body: "from b" } }, bytes: null });
    await settle();

    expect(heard).toEqual([{ frame: { $msg: { body: "from b" } }, bytes: null }]);
  });

  it("carries octets through the splitter and back out unchanged", async () => {
    const { a, b } = await wire();
    const heard: Delivered[] = [];
    a.onFrame((value) => heard.push(value));

    await b.send({ frame: { $chunk: { id: 1, seq: 0, bytes: 5 } }, bytes: bytes("hello") });
    await settle();

    expect(heard).toEqual([{ frame: { $chunk: { id: 1, seq: 0, bytes: 5 } }, bytes: bytes("hello") }]);
  });

  it("keeps the frames after a segment in order", async () => {
    const { a, b } = await wire();
    const heard: Delivered[] = [];
    a.onFrame((value) => heard.push(value));

    await b.send({ frame: { $chunk: { id: 1, seq: 0, bytes: 3 } }, bytes: bytes("abc") });
    await b.send({ frame: { $msg: { body: "after" } }, bytes: null });
    await settle();

    expect(heard.map((value) => value.frame)).toEqual([
      { $chunk: { id: 1, seq: 0, bytes: 3 } },
      { $msg: { body: "after" } },
    ]);
    expect(heard[1]!.bytes).toBeNull();
  });
});
