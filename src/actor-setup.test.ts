import { describe, it, expect } from "vitest";
import { defineActor, defineMessages } from "../src/index.js";
import { nextMessage, nextState } from "./testing/";

type CounterIn = { type: "POKE" };
type CounterOut = { type: "DONE"; count: number };

// ── setup() ────────────────────────────────────────────────────────────────

describe("setup()", () => {
  it("returns initial state (sync)", async () => {
    const Actor = defineActor({
      name: "test",
      setup() {
        return { count: 42 };
      },
      handlers: {},
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    expect(proc.state).toEqual({ count: 42 });
    await proc.stop();
  });

  it("return initial state (async)", async () => {
    const Actor = defineActor({
      name: "test",
      async setup() {
        await new Promise((r) => setTimeout(r, 10));
        return { count: 99 };
      },
      handlers: {},
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    expect(proc.state).toEqual({ count: 99 });
    await proc.stop();
  });

  it("receives args", async () => {
    const Actor = defineActor({
      name: "test",
      setup(args: { start: number }) {
        return { count: args.start };
      },
      handlers: {},
    });
    const proc = await Actor.spawn({ start: 7 });
    await proc.ready();
    expect(proc.state).toEqual({ count: 7 });
    await proc.stop();
  });

  it("has access to fork", async () => {
    const Child = defineActor({
      name: "child",
      setup: () => ({ count: 0 }),
      handlers: {},
    });
    const Parent = defineActor({
      name: "parent",
      async setup() {
        const child = await this.fork(Child, "kid", {});
        return { childPname: child.pname };
      },
      handlers: {},
    });
    const proc = await Parent.spawn({});
    await proc.ready();
    expect(proc.state!.childPname).toBeTruthy();
    expect(proc.children.length).toBe(1);
    await proc.stop();
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
    expect(await nextMessage(proc)).toMatchObject({ type: "READY" });
    // Emits during setup go to toParent before ready()
    await proc.ready();
    expect(proc.state).toEqual({ isOk: true });
    await proc.stop();
  });

  it("only shows the public part of the state to outside", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: defineMessages<CounterIn>(),
      setup() {
        return { public: { count: 10 }, private: 11 };
      },
      handlers: {
        POKE() {
          this.state.public.count = this.state.private - 9;
        },
      },
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    expect(proc.state).toEqual({ count: 10 });
    proc.send({ type: "POKE" });
    expect(await nextState(proc)).toEqual({ count: 2 });
    await proc.stop();
  });
});

// ── afterStart() ───────────────────────────────────────────────────────────

describe("afterStart()", () => {
  it("fires after ready()", async () => {
    const events: string[] = [];
    const Actor = defineActor({
      name: "test",
      setup: () => ({ events }),
      afterStart() {
        this.state.events.push("after");
      },
      handlers: {},
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    expect(proc.state!.events).toContain("after");
    await proc.stop();
  });

  it("works with setup", async () => {
    const events: string[] = [];
    const Actor = defineActor({
      name: "test",
      setup() {
        return { events };
      },
      afterStart() {
        this.state.events.push("after");
      },
      handlers: {},
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    expect(proc.state!.events).toContain("after");
    await proc.stop();
  });

  it("can be async", async () => {
    const events: string[] = [];
    const Actor = defineActor({
      name: "test",
      setup: () => ({ events }),
      async afterStart() {
        await new Promise((r) => setTimeout(r, 10));
        this.state.events.push("async-after");
      },
      handlers: {},
    });
    const proc = await Actor.spawn({});
    await proc.ready();
    await proc.stop();
    expect(proc.state!.events).toContain("async-after");
  });
});
