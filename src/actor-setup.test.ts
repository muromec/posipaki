// ── setup / afterStart / legacy initialState+onStart tests ─────────────────

import { describe, it, expect } from "vitest";
import { defineActor, defineMessages } from "../src/index.js";

type CounterIn = { type: "POKE" };
type CounterOut = { type: "DONE"; count: number };

// ── setup() ────────────────────────────────────────────────────────────────

describe("setup()", () => {
  it("returns initial state", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      setup() { return { count: 42 }; },
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    expect(proc.state as any).toEqual({ count: 42 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("can be async", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      async setup() {
        await new Promise(r => setTimeout(r, 10));
        return { count: 99 };
      },
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    expect(proc.state as any).toEqual({ count: 99 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("sync return works (not async)", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      setup() { return { count: 5 }; },
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    expect(proc.state as any).toEqual({ count: 5 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("receives args", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      setup(_args: { start: number }) { return { count: 7 }; },
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({ start: 7 });
    await proc.ready();
    expect(proc.state as any).toEqual({ count: 7 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("has access to fork", async () => {
    const Child = defineActor({
      name: "child",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });
    const Parent = defineActor({
      name: "parent",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      async setup(this: any) {
        const child = this.fork(Child, "kid", {});
        return { childPname: child.pname };
      },
      handlers: { POKE() {} },
    });
    const proc = Parent.spawn({});
    await proc.ready();
    expect((proc.state as any).childPname).toBeTruthy();
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("has access to emit", async () => {
    const emitted: any[] = [];
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<{ type: "READY" }>(),
      setup(this: any) {
        this.emit({ type: "READY" });
        return {};
      },
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    // Emits during setup go to toParent before ready()
    await proc.ready();
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("wins over initialState if both provided", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      setup() { return { count: 1 }; },
      initialState: () => ({ count: 999 }),
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    expect(proc.state as any).toEqual({ count: 1 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("works with expose", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<{ type: "DONE"; c: number }>(),
      setup() { return { internal: 10 }; },
      expose: (s) => ({ c: s.internal }),
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    expect(proc.state as any).toEqual({ c: 10 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });
});

// ── afterStart() ───────────────────────────────────────────────────────────

describe("afterStart()", () => {
  it("fires after ready()", async () => {
    const events: string[] = [];
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      initialState: () => ({ events }),
      afterStart(this: any) { this.state.events.push("after"); },
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 20));
    expect((proc.state as any).events).toContain("after");
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("works with setup", async () => {
    const events: string[] = [];
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      setup() { return { events }; },
      afterStart(this: any) { this.state.events.push("after"); },
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 20));
    expect((proc.state as any).events).toContain("after");
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("can be async", async () => {
    const events: string[] = [];
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      initialState: () => ({ events }),
      async afterStart(this: any) {
        await new Promise(r => setTimeout(r, 10));
        this.state.events.push("async-after");
      },
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 30));
    expect((proc.state as any).events).toContain("async-after");
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });
});

// ── legacy initialState + onStart ──────────────────────────────────────────

describe("legacy initialState + onStart", () => {
  it("initialState function returns state", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    expect(proc.state as any).toEqual({ count: 0 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("initialState literal works", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      initialState: { count: 10 },
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    expect(proc.state as any).toEqual({ count: 10 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("onStart mutates state before ready()", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      initialState: () => ({ count: 0, started: false }),
      onStart(this: any) { this.state.started = true; },
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    expect(proc.state as any).toEqual({ count: 0, started: true });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("onStart can be async", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      initialState: () => ({ count: 0, loaded: false }),
      async onStart(this: any) {
        await new Promise(r => setTimeout(r, 10));
        this.state.loaded = true;
      },
      handlers: { POKE() {} },
    });
    const proc = Actor.spawn({});
    await proc.ready();
    expect(proc.state as any).toEqual({ count: 0, loaded: true });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("onStart can fork children", async () => {
    const Child = defineActor({
      name: "child",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });
    const Parent = defineActor({
      name: "parent",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      initialState: () => ({ count: 0, childPname: "" }),
      onStart(this: any) {
        const child = this.fork(Child, "my-child", {});
        this.state.childPname = child.pname;
      },
      handlers: { POKE() {} },
    });
    const proc = Parent.spawn({});
    await proc.ready();
    expect((proc.state as any).childPname).toBeTruthy();
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });
});
