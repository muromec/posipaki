// ── a stream pair ───────────────────────────────────────────────────────────
//
// Two `PassThrough`s, with no child, socket or file.  What only a real stream can show is the subject: which of
// the three endings this side's readers hear, and when a send counts as done.

import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { ChannelClosed } from "./channel.js";
import { streamChannel } from "./stream.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Let the streams deliver what was written to them. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const channel = streamChannel({ read: incoming, write: outgoing });
  /** What the far end would read. */
  const received: Buffer[] = [];
  outgoing.on("data", (chunk: Buffer) => received.push(chunk));
  const sent = (): string => Buffer.concat(received).toString("utf8");
  return { channel, incoming, outgoing, sent };
}

describe("a channel over a stream pair", () => {
  it("hands up every chunk as it arrives", async () => {
    const { channel, incoming } = harness();
    const seen: string[] = [];
    channel.onFrame((chunk) => seen.push(new TextDecoder().decode(chunk)));

    incoming.write("one");
    incoming.write("two");
    await settle();

    expect(seen).toEqual(["one", "two"]);
  });

  it("carries octets unchanged, whatever they were", async () => {
    const { channel, incoming } = harness();
    const seen: number[][] = [];
    channel.onFrame((chunk) => seen.push([...chunk]));

    incoming.write(Buffer.from([0xff, 0x00, 0x0a, 0xc3]));
    await settle();

    expect(seen).toEqual([[0xff, 0x00, 0x0a, 0xc3]]);
  });

  it("hands a frame to every reader of this side", async () => {
    const { channel, incoming } = harness();
    const first: string[] = [];
    const second: string[] = [];
    channel.onFrame((chunk) => first.push(new TextDecoder().decode(chunk)));
    channel.onFrame((chunk) => second.push(new TextDecoder().decode(chunk)));

    incoming.write("both");
    await settle();

    expect([first, second]).toEqual([["both"], ["both"]]);
  });

  it("settles a send once the far end has the bytes", async () => {
    const { channel, sent } = harness();

    await channel.send(bytes("hello"));

    expect(sent()).toBe("hello");
  });

  it("hears the far end close, once — and a reader that comes later hears it too", async () => {
    const { channel, incoming } = harness();
    const reasons: string[] = [];
    channel.onClose((reason) => reasons.push(reason));

    incoming.end();
    await settle();
    channel.onClose((reason) => reasons.push(reason));

    expect(reasons).toEqual(["the far end closed", "the far end closed"]);
  });

  it("closing here ends the write side and says nothing to this side's readers", async () => {
    const { channel, outgoing } = harness();
    const reasons: string[] = [];
    let farEnded = false;
    channel.onClose((reason) => reasons.push(reason));
    outgoing.on("end", () => {
      farEnded = true;
    });

    await channel.close();
    await settle();

    expect(farEnded).toBe(true);
    expect(reasons).toEqual([]);
  });

  it("refuses a send on a channel that is over", async () => {
    const { channel, incoming } = harness();
    incoming.end();
    await settle();

    await expect(channel.send(bytes("late"))).rejects.toBeInstanceOf(ChannelClosed);
  });

  it("reports a broken wire as an error, and then a close", async () => {
    const { channel, incoming } = harness();
    const errors: unknown[] = [];
    const reasons: string[] = [];
    channel.onError((error) => errors.push(error));
    channel.onClose((reason) => reasons.push(reason));

    incoming.destroy(new Error("socket hang up"));
    await settle();

    expect((errors[0] as Error).message).toBe("socket hang up");
    expect(errors).toHaveLength(1);
    expect(reasons).toEqual(["the wire failed"]);
  });
});
