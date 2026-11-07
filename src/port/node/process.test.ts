// ── the ports that wrap a process ───────────────────────────────────────────
//
// A real `/bin/sh` behind the actor.  The ending is state, not a message: the actor puts it in `state.end` and
// stops, so the test reads it there once the actor has gone.

import { afterEach, describe, expect, it } from "vitest";

import { createCollector, createRootTracker } from "../../testing/index.js";
import { BinaryPort, Utf8Port } from "./process.js";

type Utf8Out = { type: "DATA"; data: string };
type BinaryOut = { type: "DATA"; data: Uint8Array };

const tracker = createRootTracker();

afterEach(async () => {
  // Nothing here should outlive its case; this is the belt that says so.
  await tracker.stopAll();
});

describe("Utf8Port", () => {
  it("carries the lines the child wrote, and leaves the ending in state", async () => {
    const collector = createCollector<Utf8Out>({ type: "DATA" });
    const proc = await Utf8Port.spawn(
      { command: ["/bin/sh", "-c", "printf 'one\\ntwo\\n'; exit 3"] },
      { addPlugins: [tracker.plugin, collector.plugin] },
    );
    await proc.ready();
    await proc.wait();

    expect(collector.messages).toEqual([
      { type: "DATA", data: "one" },
      { type: "DATA", data: "two" },
    ]);
    expect(proc.state?.end).toEqual({ kind: "exit", code: 3 });
    expect(proc.state?.alive).toBe(false);
  });

  it("writes what it is told to send", async () => {
    const collector = createCollector<Utf8Out>({ type: "DATA" });
    const proc = await Utf8Port.spawn(
      { command: ["/bin/sh", "-c", "cat"] },
      { addPlugins: [tracker.plugin, collector.plugin] },
    );
    await proc.ready();

    proc.send({ type: "SEND", data: "ping\n" });
    const echoed = await collector.next({ type: "DATA" });
    if (!echoed.ok) throw new Error(echoed.detail);
    expect(collector.messages).toContainEqual({ type: "DATA", data: "ping" });

    proc.send({ type: "STOP" });
    await proc.wait();
  });
});

describe("BinaryPort", () => {
  it("carries octets, not lines", async () => {
    const collector = createCollector<BinaryOut>({ type: "DATA" });
    const proc = await BinaryPort.spawn(
      { command: ["/bin/sh", "-c", "printf 'ab'"] },
      { addPlugins: [tracker.plugin, collector.plugin] },
    );
    await proc.ready();
    await proc.wait();

    const frames = collector.messages.filter(
      (msg): msg is { type: "DATA"; data: Uint8Array } => msg.type === "DATA",
    );
    expect(Buffer.concat(frames.map((frame) => Buffer.from(frame.data))).toString()).toBe("ab");
    expect(proc.state?.end).toEqual({ kind: "exit", code: 0 });
  });
});
