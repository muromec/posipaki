// ── Test Plugin Tests ────────────────────────────────────────────────────
//
// RED PHASE — tests for createCollector and createRootTracker.
// These will fail until the implementation exists.

import { describe, it, expect } from "vitest";
import { defineActor, defineMessages } from "../define-actor.js";
import type { Message } from "../types.js";

// We'll import from the module once it exists
// import { createCollector, createRootTracker } from "./test-plugin.js";

// ── helpers ──────────────────────────────────────────────────────────────

interface PokeMsg extends Message { type: "POKE"; n: number; }
interface PongMsg extends Message { type: "PONG"; n: number; }
const Pin = defineMessages<PokeMsg>();
const Pout = defineMessages<PongMsg>();

// ── createCollector ──────────────────────────────────────────────────────

describe("createCollector", () => {
  it("collects emitted messages matching a spec", async () => {
    // TODO: import { createCollector } from './test-plugin';
    const { createCollector } = await import("./test-plugin.js");

    const actor = defineActor({
      setup: () => ({ count: 0 }),
      handlers: {
        POKE(this: any, msg: PokeMsg) {
          this.state.count += msg.n;
          this.emit({ type: "PONG", n: this.state.count } as PongMsg);
        },
      },
    });

    const collector = createCollector<PongMsg>({ type: "PONG" });
    const proc = await actor.spawn({}, { addPlugins: [collector.plugin] });
    await new Promise(r => setTimeout(r, 10));

    proc.send({ type: "POKE", n: 1 });
    proc.send({ type: "POKE", n: 2 });
    await new Promise(r => setTimeout(r, 10));

    expect(collector.messages.length).toBe(2);
    expect(collector.messages[0]).toMatchObject({ type: "PONG", n: 1 });
    expect(collector.messages[1]).toMatchObject({ type: "PONG", n: 3 });

    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("resolved() waits for matching messages", async () => {
    const { createCollector } = await import("./test-plugin.js");

    const actor = defineActor({
      setup: () => ({}),
      handlers: {
        POKE(this: any) {
          this.emit({ type: "PONG", n: 1 } as PongMsg);
        },
      },
    });

    const collector = createCollector<PongMsg>({ type: "PONG" });
    const proc = await actor.spawn({}, { addPlugins: [collector.plugin] });
    await new Promise(r => setTimeout(r, 10));

    proc.send({ type: "POKE", n: 1 });
    const result = await collector.resolved();

    expect(result.ok).toBe(true);
    expect(collector.messages.length).toBe(1);

    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("shallow matching — ignores extra fields", async () => {
    const { createCollector } = await import("./test-plugin.js");

    const actor = defineActor({
      setup: () => ({}),
      handlers: {
        POKE(this: any) {
          this.emit({ type: "PONG", n: 42, extra: "ignored" } as any);
        },
      },
    });

    const collector = createCollector<any>({ type: "PONG" });
    const proc = await actor.spawn({}, { addPlugins: [collector.plugin] });
    await new Promise(r => setTimeout(r, 10));

    proc.send({ type: "POKE", n: 1 });
    const result = await collector.resolved();

    expect(result.ok).toBe(true);
    expect(collector.messages[0].n).toBe(42);

    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("resolved() times out when no match", async () => {
    const { createCollector } = await import("./test-plugin.js");

    const actor = defineActor({
      setup: () => ({}),
      handlers: { POKE() {} },
    });

    const collector = createCollector<PongMsg>({ type: "PONG" }, { timeoutMs: 100 });
    const proc = await actor.spawn({}, { addPlugins: [collector.plugin] });
    await new Promise(r => setTimeout(r, 10));

    // No PONG ever emitted
    const result = await collector.resolved();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Timeout");

    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("next() waits for additional matches", async () => {
    const { createCollector } = await import("./test-plugin.js");

    const actor = defineActor({
      setup: () => ({ count: 0 }),
      handlers: {
        POKE(this: any, msg: PokeMsg) {
          this.state.count += msg.n;
          this.emit({ type: "PONG", n: this.state.count } as PongMsg);
        },
      },
    });

    const collector = createCollector<PongMsg>({ type: "PONG", n: 1 });
    const proc = await actor.spawn({}, { addPlugins: [collector.plugin] });
    await new Promise(r => setTimeout(r, 10));

    // First match: n=1
    proc.send({ type: "POKE", n: 1 });
    const r1 = await collector.resolved();
    expect(r1.ok).toBe(true);
    expect(collector.messages.length).toBe(1);

    // Second match: n=2 (next with new filter)
    proc.send({ type: "POKE", n: 1 }); // n=2 now
    const r2 = await collector.next({ type: "PONG", n: 2 });
    expect(r2.ok).toBe(true);
    expect(collector.messages.length).toBe(2);
    // messages accumulates across restarts
    expect(collector.messages[1].n).toBe(2);

    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("reset() clears match state", async () => {
    const { createCollector } = await import("./test-plugin.js");

    const actor = defineActor({
      setup: () => ({ count: 0 }),
      handlers: {
        POKE(this: any, msg: PokeMsg) {
          this.state.count += msg.n;
          this.emit({ type: "PONG", n: this.state.count } as PongMsg);
        },
      },
    });

    const collector = createCollector<PongMsg>({ type: "PONG", n: 1 });
    const proc = await actor.spawn({}, { addPlugins: [collector.plugin] });
    await new Promise(r => setTimeout(r, 10));

    proc.send({ type: "POKE", n: 1 });
    await collector.resolved();

    // Reset with new filter
    collector.reset({ type: "PONG", n: 2 });
    proc.send({ type: "POKE", n: 1 });

    const r = await collector.resolved();
    expect(r.ok).toBe(true);
    // messages still accumulate
    expect(collector.messages.length).toBe(2);

    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("scope: only root actor by default", async () => {
    const { createCollector } = await import("./test-plugin.js");

    const child = defineActor({
      name: "kid",
      setup: () => ({}),
      handlers: {
        POKE(this: any) {
          this.emit({ type: "PONG", n: 99 } as PongMsg);
        },
      },
    });

    const parent = defineActor({
      name: "dad",
      setup() { return {}; },
      handlers: {
        POKE(this: any) {
          this.emit({ type: "PONG", n: 1 } as PongMsg);
        },
      },
      async afterStart(this: any) {
        await this.fork(child, {});
      },
    });

    // Collector on parent — should only see parent's emits
    const collector = createCollector<PongMsg>({ type: "PONG" });
    const proc = await parent.spawn({}, { addPlugins: [collector.plugin] });
    await new Promise(r => setTimeout(r, 50));

    // Child emits PONG n=99, parent emits PONG n=1
    proc.send({ type: "POKE", n: 1 });
    await new Promise(r => setTimeout(r, 50));

    // Should only have parent's emit (n=1), not child's (n=99)
    const parentEmits = collector.messages.filter((m: any) => m.n === 1);
    expect(parentEmits.length).toBe(1);
    const childEmits = collector.messages.filter((m: any) => m.n === 99);
    expect(childEmits.length).toBe(0);

    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("scope: '*' includes all emitters", async () => {
    const { createCollector } = await import("./test-plugin.js");

    const child = defineActor({
      name: "kid",
      setup: () => ({}),
      handlers: {
        POKE(this: any) {
          this.emit({ type: "PONG", n: 99 } as PongMsg);
        },
      },
    });

    const parent = defineActor({
      name: "dad",
      setup() { return {}; },
      handlers: {
        POKE(this: any) {
          this.emit({ type: "PONG", n: 1 } as PongMsg);
        },
      },
      async afterStart(this: any) {
        await this.fork(child, {});
      },
    });

    const collector = createCollector<PongMsg>({ type: "PONG" }, { scope: "*" });
    const proc = await parent.spawn({}, { addPlugins: [collector.plugin] });
    await new Promise(r => setTimeout(r, 50));

    proc.send({ type: "POKE", n: 1 });
    await new Promise(r => setTimeout(r, 50));

    // Should see both parent and child emits
    expect(collector.messages.length).toBeGreaterThanOrEqual(2);

    proc.send({ type: "STOP" });
    await proc.wait();
  });
});

// ── createRootTracker ────────────────────────────────────────────────────

describe("createRootTracker", () => {
  it("stopAll() sends STOP to all tracked processes", async () => {
    const { createRootTracker } = await import("./test-plugin.js");

    const tracker = createRootTracker();

    const actor = defineActor({
      setup: () => ({ exited: false }),
      handlers: { POKE() {} },
      onEnd(this: any) { this.state.exited = true; },
    });

    const proc = await actor.spawn({}, { addPlugins: [tracker.plugin] });
    await new Promise(r => setTimeout(r, 10));

    await tracker.stopAll();
    await proc.wait();

    expect(proc.state.exited).toBe(true);
  });

  it("survives processes that already exited", async () => {
    const { createRootTracker } = await import("./test-plugin.js");

    const tracker = createRootTracker();

    const actor = defineActor({
      setup: () => ({}),
      handlers: { POKE() {} },
    });

    const proc = await actor.spawn({}, { addPlugins: [tracker.plugin] });
    await new Promise(r => setTimeout(r, 10));

    proc.send({ type: "STOP" });
    await proc.wait();

    // Should not throw — already exited process
    await tracker.stopAll();
  });

  it("tracks multiple processes independently", async () => {
    const { createRootTracker } = await import("./test-plugin.js");

    const tracker = createRootTracker();

    const actor = defineActor({
      setup: () => ({ exited: false }),
      handlers: { POKE() {} },
      onEnd(this: any) { this.state.exited = true; },
    });

    const p1 = await actor.spawn({}, { name: "p1", addPlugins: [tracker.plugin] });
    const p2 = await actor.spawn({}, { name: "p2", addPlugins: [tracker.plugin] });
    await new Promise(r => setTimeout(r, 10));

    await tracker.stopAll();
    await Promise.all([p1.wait(), p2.wait()]);

    expect(p1.state.exited).toBe(true);
    expect(p2.state.exited).toBe(true);
  });
});
