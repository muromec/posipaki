// ── the ports that wrap a process ───────────────────────────────────────────
//
// A real `/bin/sh` behind the actor.  The messages are collected with the library's own collector rather than
// with a listener of my own, so a failure says what was expected and what arrived.

import { afterEach, describe, expect, it } from "vitest";

import { createCollector, createRootTracker, nextMessage } from "../../testing/index.js";
import { BinaryPort, Utf8Port, type PortExitMessage } from "./process.js";

type Utf8Out = { type: "DATA"; data: string } | PortExitMessage;
type BinaryOut = { type: "DATA"; data: Uint8Array } | PortExitMessage;

const tracker = createRootTracker();

afterEach(async () => {
  // Nothing here should outlive its case; this is the belt that says so.
  await tracker.stopAll();
});

describe("Utf8Port", () => {
  it("carries the lines the child wrote, then its exit", async () => {
    const collector = createCollector<Utf8Out>([{ type: "DATA" }, { type: "DATA" }, { type: "ENDED" }]);
    const proc = await Utf8Port.spawn(
      { command: ["/bin/sh", "-c", "printf 'one\\ntwo\\n'; exit 3"] },
      { addPlugins: [tracker.plugin, collector.plugin] },
    );
    await proc.ready();

    const result = await collector.resolved();
    if (!result.ok) throw new Error(result.detail);
    expect(collector.messages).toEqual([
      { type: "DATA", data: "one" },
      { type: "DATA", data: "two" },
      { type: "ENDED", code: 3, signal: null },
    ]);
  });

  it("writes what it is told to send", async () => {
    const proc = await Utf8Port.spawn({ command: ["/bin/sh", "-c", "cat"] }, { addPlugins: [tracker.plugin] });
    await proc.ready();

    proc.send({ type: "SEND", data: "ping\n" });
    const echoed = await nextMessage(proc);
    expect(echoed).toEqual({ type: "DATA", data: "ping" });

    proc.send({ type: "STOP" });
    await proc.wait();
  });
});

describe("BinaryPort", () => {
  it("carries octets, not lines, and still says how it ended", async () => {
    const collector = createCollector<BinaryOut>({ type: "ENDED" });
    const proc = await BinaryPort.spawn(
      { command: ["/bin/sh", "-c", "printf 'ab'"] },
      { addPlugins: [tracker.plugin, collector.plugin] },
    );
    await proc.ready();

    const result = await collector.resolved();
    if (!result.ok) throw new Error(result.detail);

    const frames = collector.messages.filter(
      (msg): msg is { type: "DATA"; data: Uint8Array } => msg.type === "DATA",
    );
    expect(Buffer.concat(frames.map((frame) => Buffer.from(frame.data))).toString()).toBe("ab");
    expect(collector.messages[collector.messages.length - 1]).toEqual({ type: "ENDED", code: 0, signal: null });
  });
});
