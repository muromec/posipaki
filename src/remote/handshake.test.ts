// ── the handshake ───────────────────────────────────────────────────────────
//
// Two memory channels, one of them driven by hand, so the cases are the agreement itself rather than a medium.
// They cover each way it can fail: silence, another protocol, a peer that talks before announcing, and a peer
// that leaves.  One more covers a frame sent before anyone was reading.

import { describe, expect, it } from "vitest";

import { handshake, HandshakeError, PROTO_KEY, protoFrame } from "./handshake.js";
import type { Delivered } from "./protocols/json1.js";
import { memoryChannelPair } from "../port/index.js";

const VERSION = "json.v1";

function harness() {
  const { near, far } = memoryChannelPair<Delivered>();
  /** What the far end hears from this side. */
  const heard: Delivered[] = [];
  far.onFrame((value) => heard.push(value));
  return { near, far, heard };
}

describe("the handshake", () => {
  it("announces this side and agrees with a peer that speaks the same", async () => {
    const { near, far, heard } = harness();
    const settling = handshake(near, { version: VERSION });

    await far.send(protoFrame(VERSION));
    const wire = await settling;

    expect(heard).toEqual([protoFrame(VERSION)]);
    const read: Delivered[] = [];
    wire.onFrame((value) => read.push(value));
    await far.send({ frame: { $msg: {} }, bytes: null });
    expect(read).toEqual([{ frame: { $msg: {} }, bytes: null }]);
  });

  it("holds a frame that arrives before anyone reads, and gives it to the first reader", async () => {
    const { near, far } = harness();
    const settling = handshake(near, { version: VERSION });

    await far.send(protoFrame(VERSION));
    const wire = await settling;
    await far.send({ frame: { $init: {} }, bytes: null });

    const read: Delivered[] = [];
    wire.onFrame((value) => read.push(value));
    expect(read).toEqual([{ frame: { $init: {} }, bytes: null }]);
  });

  it("refuses a peer that speaks another protocol, and names both", async () => {
    const { near, far } = harness();
    const settling = handshake(near, { version: VERSION });

    await far.send(protoFrame("frames.v2"));

    await expect(settling).rejects.toThrow(new HandshakeError("the far end speaks frames.v2, and this side speaks json.v1"));
  });

  it("refuses a peer that says something else before it says what it speaks", async () => {
    const { near, far } = harness();
    const settling = handshake(near, { version: VERSION });

    await far.send({ frame: { $msg: { body: 1 } }, bytes: null });

    await expect(settling).rejects.toThrow(/before it said which protocol it speaks/);
  });

  it("lets a caller claim a frame that is not a handshake, and keeps waiting", async () => {
    const { near, far } = harness();
    const early: Delivered[] = [];
    const settling = handshake(near, { version: VERSION, onEarly: (value) => early.push(value) });

    await far.send({ frame: { $fd: { fd: 1, data: "hello" } }, bytes: null });
    await far.send(protoFrame(VERSION));
    await settling;

    expect(early).toEqual([{ frame: { $fd: { fd: 1, data: "hello" } }, bytes: null }]);
  });

  it("gives up on a peer that never speaks", async () => {
    const { near } = harness();

    await expect(handshake(near, { version: VERSION, timeoutMs: 20 })).rejects.toThrow(
      /no protocol frame within 20ms/,
    );
  });

  it("gives up on a peer that leaves first", async () => {
    const { near, far } = harness();
    const settling = handshake(near, { version: VERSION });

    await far.close("gone");

    await expect(settling).rejects.toThrow(/the connection closed during the handshake: gone/);
  });

  it("carries the announced key in the frame it writes", async () => {
    const { near, far, heard } = harness();
    const settling = handshake(near, { version: VERSION });
    await far.send(protoFrame(VERSION));
    await settling;

    expect(heard[0]!.frame[PROTO_KEY]).toBe(VERSION);
  });
});
