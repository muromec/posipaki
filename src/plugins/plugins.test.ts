/* eslint-disable unicorn/consistent-function-scoping */
// ── Plugin System Tests ─────────────────────────────────────────────────
//
// Tests plugin installation, inheritance, hook propagation across fork,
// opt-out, and transform.

import { describe, it, expect, vi } from "vitest";
import { defineActor, defineMessages } from "../define-actor.js";
import { stopPropagation, mergeConfigs } from "../hooks.js";
import type { ActorPlugin } from "../hooks.js";
import type { Message } from "../types.js";

// ── helpers ──────────────────────────────────────────────────────────────

interface PokeMsg extends Message {
  type: "POKE";
  n: number;
}
interface PongMsg extends Message {
  type: "PONG";
  n: number;
}
const Pin = defineMessages<PokeMsg>();
const Pout = defineMessages<PongMsg>();

/** A test plugin that records every hook call. */
function spyPlugin(id: string) {
  const calls: string[] = [];
  const fn: ActorPlugin = (config) =>
    mergeConfigs(config, {
      afterStart() {
        calls.push(`${id}:${this.name}:afterStart`);
      },
      onMessage(msg) {
        calls.push(`${id}:onMessage:${msg.type}`);
      },
      onEmit() {
        calls.push(`${id}:onEmit`);
      },
      onChildExit(name) {
        calls.push(`${id}:onChildExit:${name}`);
      },
      onError() {
        calls.push(`${id}:onError`);
      },
      beforeEnd() {
        calls.push(`${id}:${this.name}:beforeEnd`);
      },
    });
  return Object.assign(fn, { calls });
}

// ── basic plugin install ─────────────────────────────────────────────────

describe("plugin basic", () => {
  it("plugin.install is called at fork time", async () => {
    let installed = false;
    const plug: ActorPlugin = async (config) => {
      installed = true;
      return config;
    };

    const Actor = defineActor({
      name: "a",
      plugins: [plug],
      handlers: {},
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    expect(installed).toBe(true);
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("plugin hooks fire", async () => {
    const sp = spyPlugin("A");
    const Actor = defineActor({
      name: "a",
      inMessages: Pin,
      outMessages: Pout,
      plugins: [sp],
      handlers: {
        POKE(this) {
          this.emit({ type: "PONG", n: 99 });
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();

    // onStart fires during startup
    expect(sp.calls).toContain("A:a:afterStart");

    proc.send!({ type: "POKE", n: 1 });
    await new Promise((r) => setTimeout(r, 0));

    expect(sp.calls).toContain("A:onMessage:POKE");
    expect(sp.calls).toContain("A:onEmit");

    proc.send({ type: "STOP" });
    await proc.wait();

    expect(sp.calls).toContain("A:a:beforeEnd");
  });

  it("plugin onStart receives state", async () => {
    // Test via onStart:
    const Actor2 = defineActor({
      name: "b",
      inMessages: Pin,
      outMessages: Pout,
      setup: () => ({ count: 99 }),
      afterStart() {
        this.state.count++;
      },
      handlers: { POKE() {} },
    });

    const proc2 = await Actor2.spawn({});
    await proc2.ready();
    expect(proc2.state!.count).toBe(100);
    proc2.send!({ type: "STOP" });
    await proc2.wait();
  });
});

// ── inheritance ──────────────────────────────────────────────────────────

describe("plugin inheritance", () => {
  it("child inherits parent plugins by default", async () => {
    const parentSpy = spyPlugin("PARENT");

    const Child = defineActor({
      name: "child",
      inMessages: Pin,
      // No plugins — inherits from parent
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: "parent",
      plugins: [parentSpy],
      async setup() {
        const c = await this.fork(Child, undefined, {});
        await c.ready();
        c.send({ type: "POKE", n: 3 });
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    proc.send({ type: "STOP" });
    await proc.wait();

    expect(parentSpy.calls).toContain("PARENT:parent:child:afterStart");
    expect(parentSpy.calls).toContain("PARENT:onMessage:POKE");
  });

  it("plugins: [] blocks inheritance", async () => {
    const parentSpy = spyPlugin("PARENT");
    const childSpy = spyPlugin("CHILD");

    const Child = defineActor({
      name: "child",
      inMessages: Pin,
      plugins: [childSpy], // array blocks parent inheritance (replaced by child-spy)
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: "parent",
      plugins: [parentSpy],
      async setup() {
        const c = await this.fork(Child, undefined, {});
        c.send({ type: "POKE", n: 1 });
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    proc.send({ type: "STOP" });
    await proc.wait();

    // parent spy should NOT have installed on child
    expect(parentSpy.calls).not.toContain("PARENT:onMessage:POKE");
    expect(childSpy.calls).toContain("CHILD:onMessage:POKE");
  });

  it("plugins: (parents) => [...parents, extra] extends chain", async () => {
    const parentSpy = spyPlugin("PARENT");
    const extraCalls: string[] = [];

    const extraPlg: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onMessage() {
          extraCalls.push("extra:onMessage");
        },
      });

    const Child = defineActor({
      name: "child",
      inMessages: Pin,
      outMessages: Pin,
      plugins: (parents) => [...parents, extraPlg],
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: "parent",
      inMessages: Pin,
      plugins: [parentSpy],
      async setup() {
        const c = await this.fork(Child, undefined, {});
        return { c };
      },
      handlers: { POKE() {} },
    });

    const proc = await Parent.spawn({});
    await proc.ready();

    // Send a message to the child via the parent
    proc.state!.c.send!({ type: "POKE", n: 1 });

    proc.send({ type: "STOP" });
    await proc.wait();

    // Extra plugin should have fired
    expect(extraCalls).toContain("extra:onMessage");
  });
});

// ── hook propagation across fork ─────────────────────────────────────────

describe("plugin hook propagation", () => {
  it("onChildExit hook fires in parent when child exits", async () => {
    const parentSpy = spyPlugin("PARENT");

    const Child = defineActor({
      name: "child",
      handlers: {},
    });

    const Parent = defineActor({
      name: "parent",
      plugins: [parentSpy],
      async setup() {
        const child = await this.fork(Child, undefined, {});
        child.send({ type: "STOP" });
      },
      onChildExit() {
        this.exit();
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.wait();
    expect(parentSpy.calls).toContain("PARENT:onChildExit:parent:child");
  });

  it("onError hook fires in plugin when handler throws", async () => {
    const errors: string[] = [];
    const plg: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onError(e: unknown) {
          errors.push((e as Error).message);
        },
      });

    const Actor = defineActor({
      name: "a",
      inMessages: Pin,
      plugins: [plg],
      handlers: {
        POKE() {
          throw new Error("KABOOM");
        },
      },
    });

    const proc = await Actor.spawn({});
    proc.send({ type: "POKE", n: 1 });
    proc.send({ type: "STOP" });
    await proc.wait();

    expect(errors).toContain("KABOOM");
  });
});

// ── adversarial ──────────────────────────────────────────────────────────

describe("plugins — adversarial", () => {
  it("plugin install failure does not crash actor", async () => {
    const badPlug: ActorPlugin = async (config) => {
      throw new Error("install failed");
    };

    const Actor = defineActor({
      name: "a",
      inMessages: Pin,
      outMessages: Pout,
      setup: () => ({ x: 0 }),
      plugins: [badPlug],
      handlers: {
        POKE() {
          this.state.x += 1;
        },
      },
    });

    const proc = await Actor.spawn({});

    // Actor should still be alive
    proc.send({ type: "POKE", n: 1 });
    proc.send({ type: "STOP" });
    await proc.wait();
    expect(proc.state!.x).toBe(1);
  });

  it("multiple plugins fire in definition order", async () => {
    const order: string[] = [];
    const make =
      (id: string): ActorPlugin =>
      (config) =>
        mergeConfigs(config, {
          onMessage() {
            order.push(id);
          },
        });

    const Actor = defineActor({
      name: "a",
      inMessages: Pin,
      plugins: [make("A"), make("B"), make("C")],
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    proc.send({ type: "POKE", n: 1 });
    proc.send({ type: "STOP" });
    await proc.wait();

    // mergeConfigs chains: last plugin fires first (middleware order)
    expect(order).toEqual(["C", "B", "A"]);
  });

  it("grandchild inherits from root via chain", async () => {
    const rootSpy = spyPlugin("ROOT");

    const Grandchild = defineActor({
      name: "gc",
      inMessages: Pin,
      handlers: {
        POKE() {},
      },
    });

    const Child = defineActor({
      name: "child",
      async setup() {
        const gc = await this.fork(Grandchild, undefined, {});
        return { gc };
      },
      handlers: {},
    });

    const Root = defineActor({
      name: "root",
      plugins: [rootSpy],
      async setup() {
        const c = await this.fork(Child, undefined, {});
        return { c };
      },
      handlers: {},
    });

    const proc = await Root.spawn({});
    await proc.ready();

    // GC should work
    const child = proc.state!.c;
    await child.ready();
    const gc = child.state!.gc;
    expect(gc).not.toBeNull();

    gc.send({ type: "POKE", n: 1 });
    gc.send({ type: "STOP" });
    await gc.wait();
    expect(rootSpy.calls).toContain("ROOT:onMessage:POKE");

    proc.send!({ type: "STOP" });
    await proc.wait();
  });
});

// ── hook ordering: plugins + actor hooks ─────────────────────────────────

describe("hook ordering: plugins + actor hooks", () => {
  it("two plugins + actor onMessage all fire in registration order", async () => {
    const order: string[] = [];

    const plug1: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onMessage() {
          order.push("plug1");
        },
      });
    const plug2: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onMessage() {
          order.push("plug2");
        },
      });

    const Actor = defineActor({
      name: "a",
      inMessages: Pin,
      plugins: [plug1, plug2],
      onMessage() {
        order.push("actor-hook");
      },
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    proc.send({ type: "POKE", n: 1 });
    proc.send({ type: "STOP" });
    await proc.wait();

    // mergeConfigs chains: last plugin fires first, then actor hook
    expect(order).toEqual(["plug2", "plug1", "actor-hook"]);
  });

  it("plugin onMessage short-circuits before actor hook", async () => {
    const order: string[] = [];

    const plug: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onMessage() {
          order.push("plug");
          return stopPropagation();
        },
      });

    const Actor = defineActor({
      name: "a",
      inMessages: Pin,
      outMessages: Pout,
      plugins: [plug],
      onMessage() {
        order.push("actor-hook");
      },
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send({ type: "POKE", n: 1 });
    proc.send({ type: "STOP" });
    await proc.wait();

    expect(order).toEqual(["plug"]); // actor hook NOT called
  });
});

// ── full lifecycle: all seven hooks fire ──────────────────────────────────

describe("full lifecycle coverage", () => {
  it("all seven hooks fire across actor start → message → stop → end", async () => {
    const fired: string[] = [];

    const trace = (name: string) => () => {
      fired.push(name);
    };

    const Actor = defineActor({
      name: "a",
      inMessages: Pin,
      outMessages: Pout,
      afterStart: trace("afterStart"),
      onMessage: trace("onMessage"),
      onStopRequested() {
        fired.push("onStopRequested");
        this.agreeToStop();
      },
      beforeEnd: trace("beforeEnd"),
      handlers: {
        POKE() {
          fired.push("handler:POKE");
          this.emit({ type: "PONG", n: 42 });
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();

    // onStart should have fired
    expect(fired).toContain("afterStart");

    // Send a message — onMessage + handler:POKE should fire
    proc.send({ type: "POKE", n: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).toContain("onMessage");
    expect(fired).toContain("handler:POKE");

    // Stop — onStopRequested should fire
    proc.send({ type: "STOP" });
    await proc.wait();
    expect(fired).toContain("onStopRequested");
    expect(fired).toContain("beforeEnd");
  });

  it("plugin beforeEnd fires before actor beforeEnd", async () => {
    const order: string[] = [];

    const plug: ActorPlugin = (config) =>
      mergeConfigs(config, {
        beforeEnd() {
          order.push("plug");
        },
      });

    const Actor = defineActor({
      name: "a",
      plugins: [plug],
      beforeEnd() {
        order.push("actor-hook");
      },
      handlers: {},
    });

    const proc = await Actor.spawn({});
    proc.send({ type: "STOP" });
    await proc.wait();

    // Plugin beforeEnd fires before actor hooks.beforeEnd
    expect(order).toEqual(["plug", "actor-hook"]);
  });

  it("plugin onStopRequested fires before actor onStopRequested", async () => {
    const order: string[] = [];

    const plug: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onStopRequested() {
          order.push("plug");
        },
      });

    const Actor = defineActor({
      name: "a",
      plugins: [plug],
      onStopRequested() {
        order.push("actor-hook");
        this.agreeToStop();
      },
      handlers: {},
    });

    const proc = await Actor.spawn({});
    proc.send({ type: "STOP" });
    await proc.wait();

    expect(order).toEqual(["plug", "actor-hook"]);
  });

  it("plugin onEmit fires before actor onEmit", async () => {
    const order: string[] = [];

    const plug: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onEmit() {
          order.push("plug");
        },
      });

    const Actor = defineActor({
      name: "a",
      inMessages: Pin,
      outMessages: Pout,
      plugins: [plug],
      onEmit() {
        order.push("actor-hook");
      },
      handlers: {
        POKE() {
          this.emit({ type: "PONG", n: 1 });
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send({ type: "POKE", n: 1 });
    proc.send({ type: "STOP" });
    await proc.wait();

    expect(order).toEqual(["plug", "actor-hook"]);
  });

  it("plugin onChildExit fires before actor onChildExit", async () => {
    const order: string[] = [];

    const plug: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onChildExit(name: string) {
          order.push(`plug:${name}`);
        },
      });

    const Child = defineActor({
      name: "child",
      afterStart(this: any) {
        this.exit();
      },
      handlers: {},
    });

    const Parent = defineActor({
      name: "parent",
      plugins: [plug],
      onChildExit(name: string) {
        order.push(`actor-hook:${name}`);
        this.exit();
      },
      setup() {
        this.fork(Child, undefined, {});
        return null;
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.wait();

    expect(order[0]).toMatch(/^plug:/);
    expect(order[1]).toMatch(/^actor-hook:/);
  });
});

// ── onError: plugins + actor ordering ────────────────────────────────────

describe("onError: plugins + actor ordering", () => {
  it("two plugins + actor onError all fire in registration order", async () => {
    const errors: string[] = [];

    const plug1: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onError(e: unknown) {
          errors.push(`plug1:${(e as Error).message}`);
        },
      });
    const plug2: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onError(e: unknown) {
          errors.push(`plug2:${(e as Error).message}`);
        },
      });

    const Actor = defineActor({
      name: "a",
      inMessages: Pin,
      plugins: [plug1, plug2],
      onError(e: unknown) {
        errors.push(`actor-hook:${(e as Error).message}`);
      },
      handlers: {
        POKE() {
          throw new Error("KABOOM");
        },
      },
    });

    const proc = await Actor.spawn({});
    proc.send({ type: "POKE", n: 1 });
    proc.send({ type: "STOP" });
    await proc.wait();

    // chainHook: plug2 fires first, then plug1, then actor-hook
    expect(errors).toEqual(["plug2:KABOOM", "plug1:KABOOM", "actor-hook:KABOOM"]);
  });

  it("error in first onError does not prevent second from firing", async () => {
    const fired: string[] = [];

    const plug1: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onError() {
          fired.push("plug1");
          throw new Error("inner error");
        },
      });
    const plug2: ActorPlugin = (config) =>
      mergeConfigs(config, {
        onError() {
          fired.push("plug2");
        },
      });

    const Actor = defineActor({
      name: "a",
      inMessages: Pin,
      plugins: [plug1, plug2],
      onError() {
        fired.push("actor-hook");
      },
      handlers: {
        POKE() {
          throw new Error("BOOM");
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send({ type: "POKE", n: 1 });
    proc.send({ type: "STOP" });
    await proc.wait();

    // chainHook: plug2 fires first, then plug1 throws.
    // callHook catches the chain error, so actor-hook is skipped.
    expect(fired).toEqual(["plug2", "plug1"]);
  });
});
