// ── Spawn API Surface Tests ──────────────────────────────────────────────
//
// Tests for the unified spawn API: spawn, spawnAsChild, self.fork with
// addPlugins in opts, parentPlugins folded into opts, and deduplication.
//
// RED PHASE — these tests describe the target API and will fail.

import { describe, it, expect, vi } from "vitest";
import { defineActor, defineMessages } from "./define-actor.js";
import { mergeConfigs, type ActorPlugin } from "./hooks.js";
import type { Message } from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────────

interface PokeMsg extends Message { type: "POKE"; n: number; }
const Pin = defineMessages<PokeMsg>();

/** A named plugin that records hook calls. */
function namedPlugin(name: string): ActorPlugin & { calls: string[] } {
  const calls: string[] = [];
  const fn = function (this: any, config: any) {
    return mergeConfigs(config, {
      afterStart() { calls.push(`${name}:${this.name}:afterStart`); },
      onEnd() { calls.push(`${name}:${this.name}:onEnd`); },
    });
  } as ActorPlugin & { calls: string[] };
  Object.defineProperty(fn, 'name', { value: name });
  fn.calls = calls;
  return fn;
}

// ── spawn: addPlugins in opts ────────────────────────────────────────────

describe("spawn addPlugins", () => {
  it("spawn accepts addPlugins in opts", async () => {
    const actor = defineActor({
      setup: () => ({}),
      handlers: { POKE() {} },
    });

    const plug = namedPlugin("spy");
    const proc = await actor.spawn({}, { addPlugins: [plug] });
    await new Promise(r => setTimeout(r, 10));

    expect(plug.calls).toContain("spy:actor:afterStart");

    proc.send({ type: "STOP" });
    await proc.wait();
  });
});

// ── spawnAsChild: parentPlugins + addPlugins in opts ─────────────────────

describe("spawnAsChild opts", () => {
  it("accepts parentPlugins in opts (no 4th positional)", async () => {
    const plug = namedPlugin("spy");

    const child = defineActor({
      name: "kid",
      setup: () => ({}),
      handlers: { POKE() {} },
    });

    const parent = defineActor({
      setup() { return {}; },
      handlers: { POKE() {} },
      async afterStart(this: any) {
        // parentPlugins in opts, not 4th positional
        await child.spawnAsChild(this.ctx, {}, { parentPlugins: [plug] });
      },
    });

    const proc = await parent.spawn({});
    await new Promise(r => setTimeout(r, 50));

    expect(plug.calls).toContain("spy:kid:afterStart");

    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("parentPlugins is optional", async () => {
    const child = defineActor({
      setup: () => ({}),
      handlers: { POKE() {} },
    });

    const parent = defineActor({
      setup() { return {}; },
      handlers: { POKE() {} },
      async afterStart(this: any) {
        await child.spawnAsChild(this.ctx, {});
      },
    });

    const proc = await parent.spawn({});
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("accepts addPlugins in opts", async () => {
    const parentPlug = namedPlugin("parent");
    const addPlug = namedPlugin("add");

    const child = defineActor({
      name: "kid",
      setup: () => ({}),
      handlers: { POKE() {} },
    });

    const parent = defineActor({
      name: "dad",
      setup() { return {}; },
      handlers: { POKE() {} },
      async afterStart(this: any) {
        await child.spawnAsChild(this.ctx, {}, {
          parentPlugins: [parentPlug],
          addPlugins: [addPlug],
        });
      },
    });

    const proc = await parent.spawn({});
    await new Promise(r => setTimeout(r, 50));

    expect(parentPlug.calls).toContain("parent:kid:afterStart");
    expect(addPlug.calls).toContain("add:kid:afterStart");

    proc.send({ type: "STOP" });
    await proc.wait();
  });
});

// ── addPlugins are non-overridable ───────────────────────────────────────

describe("addPlugins non-overridable", () => {
  it("addPlugins survive child's replacePlugins", async () => {
    const addPlug = namedPlugin("add");

    const grandchild = defineActor({
      name: "grandkid",
      setup: () => ({}),
      handlers: { POKE() {} },
    });

    const child = defineActor({
      name: "kid",
      setup() { return {}; },
      handlers: { POKE() {} },
      plugins: [], // explicitly replace — strips parent plugins
      async afterStart(this: any) {
        await this.fork(grandchild, {});
      },
    });

    const parent = defineActor({
      name: "dad",
      setup() { return {}; },
      handlers: { POKE() {} },
      async afterStart(this: any) {
        await this.fork(child, {});
      },
    });

    const proc = await parent.spawn({}, { addPlugins: [addPlug] });
    await new Promise(r => setTimeout(r, 100));

    // addPlug should reach grandchild even though child replaced plugins
    expect(addPlug.calls).toContain("add:dad:afterStart");
    expect(addPlug.calls).toContain("add:dad:kid:grandkid:afterStart");

    proc.send({ type: "STOP" });
    await proc.wait();
  });
});

// ── deduplication ────────────────────────────────────────────────────────

describe("plugin dedup", () => {
  it("deduplicates by function name", async () => {
    // Same plugin instance in both config and addPlugins —
    // should still only fire once.
    const dup = namedPlugin("dup");

    const actor = defineActor({
      setup: () => ({}),
      handlers: { POKE() {} },
      plugins: [dup],
    });

    const proc = await actor.spawn({}, { addPlugins: [dup] });
    await new Promise(r => setTimeout(r, 10));

    // Should fire only once (deduplicated)
    expect(dup.calls.length).toBe(1);

    proc.send({ type: "STOP" });
    await proc.wait();
  });
});

// ── ctx type: concrete ProcessCtx without cast ───────────────────────────

describe("spawnAsChild ctx type", () => {
  it("accepts concrete ProcessCtx from this.ctx without any cast", async () => {
    const child = defineActor({
      name: "kid",
      setup: () => ({}),
      handlers: { POKE() {} },
    });

    const parent = defineActor({
      name: "typed-dad",
      setup: () => ({ x: 1 }),
      handlers: {
        POKE(msg: any) { this.state.x += msg.n; },
      },
      async afterStart(this: any) {
        // KEY: this.ctx is a concrete ProcessCtx<{x:number}, ...>.
        // It should be assignable to spawnAsChild without any cast.
        await child.spawnAsChild(this.ctx, {});
      },
    });

    // If this compiles and runs, the type fix works.
    const proc = await parent.spawn({});
    proc.send({ type: "STOP" });
    await proc.wait();
  });
});

// ── self.fork passes parentPlugins via opts ──────────────────────────────

describe("self.fork plugin propagation", () => {
  it("parent plugins reach child via self.fork", async () => {
    const spy = namedPlugin("fork-spy");

    const child = defineActor({
      name: "kid",
      setup: () => ({}),
      handlers: { POKE() {} },
    });

    const parent = defineActor({
      name: "dad",
      setup() { return {}; },
      handlers: { POKE() {} },
      plugins: [spy],
      async afterStart(this: any) {
        await this.fork(child, {});
      },
    });

    const proc = await parent.spawn({});
    await new Promise(r => setTimeout(r, 50));

    expect(spy.calls).toContain("fork-spy:dad:afterStart");
    expect(spy.calls).toContain("fork-spy:dad:kid:afterStart");

    proc.send({ type: "STOP" });
    await proc.wait();
  });
});
