// ── the seam over a port ────────────────────────────────────────────────────
//
// The medium here is two memory channels with one end driven by hand: what is exercised is the composition —
// split, decode, agree, and the reader shape the seam speaks — not a fifo, a socket or a child.

import { describe, expect, it } from "vitest";

import { memoryChannelPair, type Channel, type Part } from "../port/index.js";
import { jsonSeam, jsonSeamParts } from "./seam.js";

const VERSION = "json.v1";

function line(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

/**
 * One byte medium, its far end read by hand.
 *
 * The far end answers this side's announcement with `answering`, the way a peer that speaks the protocol
 * does; `heard` is every line it was sent, in order, and `raw` every chunk before parsing, for the case that
 * is about octets rather than lines.
 */
function medium(answering: string = VERSION) {
  const { near, far } = memoryChannelPair<Uint8Array>();
  const heard: string[] = [];
  const raw: Uint8Array[] = [];
  let buffer = "";
  far.onFrame((chunk) => {
    raw.push(chunk);
    buffer += Buffer.from(chunk).toString("utf8");
    for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
      const text = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      heard.push(text);
      if (text.startsWith('{"$proto"')) void far.send(line({ $proto: answering }));
    }
  });
  const spawner = async (): Promise<Channel<Uint8Array>> => near;
  return { far, heard, raw, spawner };
}

describe("the seam over a port", () => {
  it("agrees on the protocol, and carries a frame each way", async () => {
    const { far, heard, spawner } = medium();
    const wire = await jsonSeam(spawner)(undefined);

    expect(heard).toEqual([JSON.stringify({ $proto: VERSION })]);

    const read: Record<string, unknown>[] = [];
    wire.onMessage((frame) => read.push(frame));
    await far.send(line({ $init: { args: {} } }));
    expect(read).toEqual([{ $init: { args: {} } }]);

    await wire.send({ $msg: { body: "hello" } });
    expect(heard[heard.length - 1]).toBe(JSON.stringify({ $msg: { body: "hello" } }));
  });

  it("refuses a peer that speaks another protocol, and names both", async () => {
    const { spawner } = medium("frames.v2");

    await expect(jsonSeam(spawner)(undefined)).rejects.toThrow(
      "the far end speaks frames.v2, and this side speaks json.v1",
    );
  });

  it("keeps a segment's line and its octets together, each way", async () => {
    const { far, raw, spawner } = medium();
    const wire = await jsonSeam(spawner)(undefined);

    const segments: Array<[Record<string, unknown>, Uint8Array]> = [];
    wire.onSegment?.((frame, bytes) => segments.push([frame, bytes]));
    await far.send(line({ $chunk: { bytes: 3 } }));
    await far.send(Uint8Array.of(1, 2, 3));
    expect(segments).toEqual([[{ $chunk: { bytes: 3 } }, Uint8Array.of(1, 2, 3)]]);

    await wire.sendSegment?.({ $chunk: { bytes: 2 } }, Uint8Array.of(9, 9));
    expect(Buffer.from(raw[raw.length - 1])).toEqual(
      Buffer.from('{"$chunk":{"bytes":2}}\n\x09\x09', "utf8"),
    );
  });

  it("tells this side when the far end is gone", async () => {
    const { far, spawner } = medium();
    const wire = await jsonSeam(spawner)(undefined);

    let closed = 0;
    wire.onClose(() => {
      closed += 1;
    });
    await far.close("the peer left");
    expect(closed).toBe(1);
  });
});

describe("the seam over a medium that already has parts", () => {
  it("agrees, and reads a part as a frame", async () => {
    const { near, far } = memoryChannelPair<Part>();
    let announced = false;
    far.onFrame((part) => {
      if (part.line.startsWith('{"$proto"') && !announced) {
        announced = true;
        void far.send({ line: JSON.stringify({ $proto: VERSION }), bytes: null });
      }
    });
    const wire = await jsonSeamParts(async () => near)(undefined);

    const read: Record<string, unknown>[] = [];
    wire.onMessage((frame) => read.push(frame));
    await far.send({ line: JSON.stringify({ $msg: { body: "hi" } }), bytes: null });
    expect(read).toEqual([{ $msg: { body: "hi" } }]);
  });
});
