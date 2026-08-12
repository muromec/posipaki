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
      setup() {
        return { count: 42 };
      },
      handlers: { POKE() {} },
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    expect(proc.state).toEqual({ count: 42 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("can be async", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      async setup() {
        await new Promise((r) => setTimeout(r, 10));
        return { count: 99 };
      },
      handlers: { POKE() {} },
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    expect(proc.state).toEqual({ count: 99 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("sync return works (not async)", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      setup() {
        return { count: 5 };
      },
      handlers: { POKE() {} },
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    expect(proc.state).toEqual({ count: 5 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("receives args", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      setup(args: { start: number }) {
        return { count: args.start };
      },
      handlers: { POKE() {} },
    });
    const proc = await Actor.spawn({ start: 7 });
    await proc.ready();
    expect(proc.state).toEqual({ count: 7 });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("has access to fork", async () => {
    const Child = defineActor({
      name: "child",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterIn>(),
      setup: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });
    const Parent = defineActor({
      name: "parent",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      async setup() {
        const child = await this.fork(Child, "kid", {});
        return { childPname: child.pname };
      },
      handlers: { POKE() {} },
    });
    const proc = await Parent.spawn({});
    await proc.ready();
    expect(proc.state!.childPname).toBeTruthy();
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("has access to emit", async () => {
    const emitted: any[] = [];
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<{ type: "READY" }>(),
      setup(): { isOk: boolean } {
        this.emit({ type: "READY" });
        return { isOk: true };
      },
      handlers: { POKE() {} },
    });
    const proc = await Actor.spawn({});
    // Emits during setup go to toParent before ready()
    await proc.ready();
    expect(proc.state).toEqual({ isOk: true });
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("only shows the public part of the state to outside", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<{ type: "DONE"; c: number }>(),
      setup() {
        return { public: { count: 10 }, private: 11 };
      },
      handlers: {
        POKE() {
          console.log("got poked");
          this.state.public.count = this.state.private - 9;
        },
      },
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    expect(proc.state).toEqual({ count: 10 });
    proc.send({ type: "POKE" });
    proc.send({ type: "STOP" });
    await proc.wait();
    expect(proc.state).toEqual({ count: 2 });
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
      setup: () => ({ events }),
      afterStart(this: any) {
        this.state.events.push("after");
      },
      handlers: { POKE() {} },
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    await new Promise((r) => setTimeout(r, 20));
    expect(proc.state!.events).toContain("after");
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("works with setup", async () => {
    const events: string[] = [];
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      setup() {
        return { events };
      },
      afterStart(this: any) {
        this.state.events.push("after");
      },
      handlers: { POKE() {} },
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    await new Promise((r) => setTimeout(r, 20));
    expect(proc.state!.events).toContain("after");
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });

  it("can be async", async () => {
    const events: string[] = [];
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      outMessages: defineMessages<CounterOut>(),
      setup: () => ({ events }),
      async afterStart(this: any) {
        await new Promise((r) => setTimeout(r, 10));
        this.state.events.push("async-after");
      },
      handlers: { POKE() {} },
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    await new Promise((r) => setTimeout(r, 30));
    expect(proc.state!.events).toContain("async-after");
    proc.send({ type: "STOP" }, { fromName: "t", fromId: Symbol() });
    await proc.wait();
  });
});
