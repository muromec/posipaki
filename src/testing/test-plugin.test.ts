// ── Test Plugins (GREEN) ──────────────────────────────────────────────────
//
// createCollector: event-driven message collection via onEmit, scoped by
// pname, with optional timeout + diagnostics.
// createRootTracker: global root tracking for leak-free test cleanup.

import { describe, it, expect } from "vitest";
import { defineActor, defineMessages } from "../define-actor.js";
import type { Message } from "../types.js";
import { createCollector, createRootTracker, type Collector } from "./test-plugin.js";
import { times } from "./msg-matcher.js";

// ── test actor ────────────────────────────────────────────────────────────

interface PokeMsg extends Message {
  type: "POKE";
  n: number;
}
interface PongMsg extends Message {
  type: "PONG";
  n: number;
}
interface ByeMsg extends Message {
  type: "BYE";
}

type EmitterOut = PongMsg | ByeMsg;

const Emitter = defineActor({
  name: "emitter",
  inMessages: defineMessages<PokeMsg | ByeMsg>(),
  outMessages: defineMessages<EmitterOut>(),
  setup() {
    return { count: 0 };
  },
  handlers: {
    POKE(msg) {
      this.state.count += msg.n;
      this.emit({ type: "PONG", n: this.state.count } as EmitterOut);
    },
    BYE() {
      this.emit({ type: "BYE" } as EmitterOut);
      this.exit("bye");
    },
  },
});

async function spawnEmitter(collector: Collector<EmitterOut>) {
  const proc = await Emitter.spawn({}, { addPlugins: [collector.plugin] });
  await proc.ready();
  return proc;
}

function poke(proc: Awaited<ReturnType<typeof spawnEmitter>>, n: number) {
  proc.send({ type: "POKE", n });
}

// ── createCollector ───────────────────────────────────────────────────────

describe("createCollector", () => {
  it("collects emitted messages and resolved() settles on match", async () => {
    const collector = createCollector<EmitterOut>({ type: "PONG" });
    const proc = await spawnEmitter(collector);

    poke(proc, 1);
    poke(proc, 2);
    expect((await collector.resolved(2000)).ok).toBe(true);
    expect((await collector.next(times<EmitterOut>({ type: "PONG" }, 2), 2000)).ok).toBe(true);

    expect(collector.messages).toHaveLength(2);
    expect(collector.messages[0]).toMatchObject({ type: "PONG", n: 1 });
    expect(collector.messages[1]).toMatchObject({ type: "PONG", n: 3 });
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("resolved(timeoutMs) fails with a diagnostic when nothing matches", async () => {
    const collector = createCollector<EmitterOut>({ type: "PONG" });
    const proc = await spawnEmitter(collector);

    const result = await collector.resolved(150);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timeout after 150ms");
    expect(result.detail).toContain('expected: {"type":"PONG"}');
    expect(result.detail).toContain("received 0 message(s)");
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("pending resolved() settles ok:false when the actor exits first", async () => {
    const collector = createCollector<EmitterOut>({ type: "PONG" });
    const proc = await spawnEmitter(collector);

    const pending = collector.resolved();
    proc.send({ type: "STOP" });
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("actor exited before match");
    await proc.wait();
  });

  it("next() advances to the next expected message", async () => {
    const collector = createCollector<EmitterOut>({ type: "PONG" });
    const proc = await spawnEmitter(collector);

    poke(proc, 1);
    expect((await collector.resolved(2000)).ok).toBe(true);

    poke(proc, 2);
    const second = await collector.next({ type: "PONG", n: 3 }, 2000);
    expect(second.ok).toBe(true);
    expect(collector.messages).toHaveLength(2);
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("times() waits for the Nth occurrence", async () => {
    const collector = createCollector<EmitterOut>({ type: "PONG" });
    const proc = await spawnEmitter(collector);

    poke(proc, 1);
    poke(proc, 1);
    // Two PONGs emitted so far — wait for the third occurrence.
    const third = collector.next(times<EmitterOut>({ type: "PONG" }, 3), 2000);
    poke(proc, 1);
    const result = await third;

    expect(result.ok).toBe(true);
    expect(collector.messages).toHaveLength(3);
    // history-based: occurrences count over the whole collected history
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("sequence spec matches the tail of history in order", async () => {
    const collector = createCollector<EmitterOut>(
      [{ type: "PONG", n: 1 }, { type: "PONG", n: 3 }],
    );
    const proc = await spawnEmitter(collector);

    poke(proc, 1);
    poke(proc, 2);
    const result = await collector.resolved(2000);
    expect(result.ok).toBe(true);
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("scope filters by pname — a non-matching scope collects nothing", async () => {
    const collector = createCollector<EmitterOut>(
      { type: "PONG" },
      { scope: "other:*" },
    );
    const proc = await spawnEmitter(collector);

    poke(proc, 1);
    const result = await collector.resolved(150);
    expect(result.ok).toBe(false);
    expect(collector.messages).toHaveLength(0);
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("reset() switches the active matcher", async () => {
    const collector = createCollector<EmitterOut>({ type: "PONG" });
    const proc = await spawnEmitter(collector);

    poke(proc, 1);
    expect((await collector.resolved(2000)).ok).toBe(true);

    collector.reset({ type: "BYE" });
    const pending = collector.resolved(2000);
    proc.send({ type: "BYE" });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(collector.messages[collector.messages.length - 1]).toMatchObject({ type: "BYE" });
    await proc.wait();
  });

  it("BYE exits the actor and the collector sees the last emission", async () => {
    const collector = createCollector<EmitterOut>({ type: "BYE" });
    const proc = await spawnEmitter(collector);

    proc.send({ type: "BYE" });
    const result = await collector.resolved(2000);
    expect(result.ok).toBe(true);
    await proc.wait();
  });
});

// ── createRootTracker ─────────────────────────────────────────────────────

describe("createRootTracker", () => {
  it("tracks roots and stopAll() stops them", async () => {
    const tracker = createRootTracker();
    const collector = createCollector<EmitterOut>({ type: "PONG" });
    const proc = await Emitter.spawn({}, {
      addPlugins: [collector.plugin, tracker.plugin],
    });
    await proc.ready();

    await tracker.stopAll();
    await proc.wait();
  });

  it("stopAll() is safe to call with no tracked roots", async () => {
    const tracker = createRootTracker();
    await expect(tracker.stopAll()).resolves.toBeUndefined();
  });
});
