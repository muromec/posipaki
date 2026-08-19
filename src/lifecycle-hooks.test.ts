// ── Lifecycle Hooks Tests ───────────────────────────────────────────────
//
// Tests for defineActor hooks: onMessage, onEmit, onChildExit, onError,
// onStart, beforeEnd, onStopRequested, and stopPropagation().

import { describe, it, expect, vi } from "vitest";
import { defineActor, defineMessages } from "./define-actor.js";
import { stopPropagation, mergeConfigs, type HookResult } from "./hooks.js";
import type { Message, SenderInfo } from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────────

interface PokeMsg extends Message {
  type: "POKE";
  value: number;
}
interface PongMsg extends Message {
  type: "PONG";
  value: number;
}
type BroadMsg = PokeMsg | PongMsg;

const PokeIn = defineMessages<PokeMsg>();
const PokeOut = defineMessages<PongMsg>();
const BroadIn = defineMessages<BroadMsg>();

// ── onMessage hooks ──────────────────────────────────────────────────────

describe("hooks.onMessage", () => {
  it("fires before the named handler", async () => {
    const order: string[] = [];

    const Actor = defineActor({
      name: "test",
      inMessages: PokeIn,
      onMessage(msg) {
        order.push(`hook:${msg.type}`);
      },
      handlers: {
        POKE() {
          order.push("handler:POKE");
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send({ type: "POKE", value: 1 });
    proc.send!({ type: "STOP" });

    await proc.wait();
    expect(order).toEqual(["hook:POKE", "handler:POKE"]);
  });

  it("receives sender info", async () => {
    let capturedSender: SenderInfo | null = null;

    const Actor = defineActor({
      name: "test",
      inMessages: PokeIn,
      onMessage(_msg, sender) {
        capturedSender = sender;
      },
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send(
      { type: "POKE", value: 1 },
      { fromName: "caller", fromId: Symbol("caller") },
    );
    proc.send!({ type: "STOP" });
    await proc.wait();

    expect(capturedSender).not.toBeNull();
    expect(capturedSender!.fromName).toBe("caller");
  });
});

// ── stopPropagation ──────────────────────────────────────────────────────

describe("stopPropagation", () => {
  it("prevents handler from running", async () => {
    let handlerRan = false;
    let messageRun = false;

    const Actor = defineActor({
      name: "test",
      inMessages: PokeIn,
      onMessage() {
        messageRun = true;
        return stopPropagation();
      },
      handlers: {
        POKE() {
          handlerRan = true;
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send({ type: "POKE", value: 1 });
    proc.send({ type: "STOP" });
    await proc.wait();

    expect(handlerRan).toBe(false);
    expect(messageRun).toBe(true);
  });
});

// ── onEmit hooks ─────────────────────────────────────────────────────────

describe("hooks.onEmit", () => {
  it("fires on every emit", async () => {
    const emitted: string[] = [];

    const Actor = defineActor({
      name: "test",
      inMessages: PokeIn,
      outMessages: PokeOut,
      onEmit(msg) {
        emitted.push(msg.type);
      },
      handlers: {
        POKE() {
          this.emit({ type: "PONG", value: 99 });
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send({ type: "POKE", value: 1 });
    proc.send!({ type: "STOP" });

    await proc.wait();
    expect(emitted).toContain("PONG");
  });

  it("parent receives child emit via handler", async () => {
    const Child = defineActor({
      name: "child",
      outMessages: PokeOut,
      setup() {
        this.emit({ type: "PONG", value: 1 });
      },
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: "parent",
      inMessages: BroadIn,
      async setup() {
        await this.fork(Child, undefined, {});
        return { pongs: 0 };
      },
      async afterStart() {},
      handlers: {
        POKE() {},
        PONG() {
          this.state.pongs++;
        },
      },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    proc.send!({ type: "STOP" });
    await proc.wait();

    expect(proc.state!.pongs).toBe(1);
  });
});

// ── onChildExit hooks ────────────────────────────────────────────────────

describe("hooks.onChildExit", () => {
  it("fires when a child exits", async () => {
    const Child = defineActor({
      name: "child",
      afterStart() {
        this.exit();
      },
      handlers: {},
    });

    const Parent = defineActor({
      name: "parent",
      async setup() {
        await this.fork(Child, undefined, {});
        return { exits: [] as string[] };
      },
      onChildExit(name) {
        this.state.exits.push(name);
        this.exit("done");
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.wait();
    expect(proc.state!.exits).toContain("parent:child");
  });
});

// ── onStart / beforeEnd ordering (plugin chain via mergeConfigs) ─────────────

describe("hooks.onStart / beforeEnd", () => {
  it("plugin afterStart fires before actor afterStart", async () => {
    const order: string[] = [];

    const Actor = defineActor({
      name: "test",
      afterStart() {
        order.push("actor");
        this.exit();
      },
      plugins: [
        (cfg) =>
          mergeConfigs(cfg, {
            afterStart() {
              order.push("plugin");
            },
          }),
      ],
      handlers: {},
    });

    const proc = await Actor.spawn({});
    await proc.wait();

    expect(order).toEqual(["plugin", "actor"]);
  });

  it("plugin beforeEnd fires before actor beforeEnd", async () => {
    const order: string[] = [];

    const Actor = defineActor({
      name: "test",
      beforeEnd() {
        order.push("actor");
      },
      plugins: [
        (cfg) =>
          mergeConfigs(cfg, {
            beforeEnd() {
              order.push("plugin");
            },
          }),
      ],
      handlers: {},
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send({ type: "STOP" });
    await proc.wait();

    expect(order).toEqual(["plugin", "actor"]);
  });
  it("beforeEnd fires before EXIT, afterEnd fires after EXIT", async () => {
    const order: string[] = [];
    const Actor = defineActor({
      name: "test",
      beforeEnd() {
        order.push("beforeEnd");
      },
      afterEnd() {
        order.push("afterEnd");
      },
      handlers: {},
    });

    const proc = await Actor.spawn({}, {
      toParent: ([msg]: [any, any]) => {
        if (msg.type === "EXIT") order.push("EXIT");
      },
    });
    await proc.ready();
    proc.send({ type: "STOP" });
    await proc.wait();

    expect(order).toEqual(["beforeEnd", "EXIT", "afterEnd"]);
  });
});

// ── onStopRequested ordering (plugin chain via mergeConfigs) ─────────────

describe("hooks.onStopRequested", () => {
  it("plugin onStopRequested fires before actor onStopRequested", async () => {
    const order: string[] = [];

    const Actor = defineActor({
      name: "test",
      onStopRequested() {
        order.push("actor");
        this.agreeToStop();
      },
      plugins: [
        (cfg) =>
          mergeConfigs(cfg, {
            onStopRequested() {
              order.push("plugin");
            },
          }),
      ],
      handlers: {},
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: "STOP" });
    await proc.wait();

    expect(order).toEqual(["plugin", "actor"]);
  });
});

// ── onError hooks ────────────────────────────────────────────────────────

describe("hooks.onError", () => {
  it("fires when a handler throws", async () => {
    let capturedError: string | null = null;

    const Actor = defineActor({
      name: "test",
      inMessages: PokeIn,
      setup() {
        return { count: 0 };
      },
      onError(err) {
        capturedError = (err as Error).message;
      },
      handlers: {
        POKE(msg) {
          this.state.count += msg.value;
          throw new Error("BOOM");
        },
      },
    });

    const proc = await Actor.spawn({});
    proc.notify();
    await proc.ready();
    proc.send({ type: "POKE", value: 1 });
    proc.send({ type: "POKE", value: 10 });
    proc.send({ type: "STOP" });
    await proc.wait();

    expect(capturedError).toBe("BOOM");
    expect(proc.state!.count).toBe(11);
  });

  it("handler throw without onError kills the actor", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: PokeIn,
      setup: () => ({ count: 0 }),
      // No onError — throw should propagate and crash the process
      handlers: {
        POKE(msg) {
          this.state.count += msg.value;
          throw new Error("BOOM");
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: "POKE", value: 1 });
    proc.send!({ type: "POKE", value: 10 });

    await expect(proc.wait()).rejects.toThrow();
    expect(proc.state!.count).toBe(1);
  });
});

// ── adversarial ──────────────────────────────────────────────────────────

describe("hooks — adversarial", () => {
  it("error in onError hook does not crash the actor further", async () => {
    const Actor = defineActor({
      name: "test",
      inMessages: PokeIn,
      setup() {
        return { count: 0 };
      },
      onError() {
        throw new Error("error in error handler");
      },
      handlers: {
        POKE(msg) {
          this.state.count += msg.value;
          throw new Error("original error");
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send({ type: "POKE", value: 1 });
    proc.send({ type: "POKE", value: 10 });
    proc.send({ type: "STOP" });
    await proc.wait();
    expect(proc.state!.count).toBe(11);
  });

  it("onMessage hook that throws does not skip handler", async () => {
    let handlerRan = false;

    const Actor = defineActor({
      name: "test",
      inMessages: PokeIn,
      onMessage() {
        throw new Error("hook error");
      },
      onError() {},
      handlers: {
        POKE() {
          handlerRan = true;
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: "POKE", value: 1 });
    proc.send!({ type: "STOP" }, { fromName: "test", fromId: Symbol("test") });
    await proc.wait();

    expect(handlerRan).toBe(true);
  });

  it("stopPropagation works with async hooks", async () => {
    let handlerRan = false;

    const Actor = defineActor({
      name: "test",
      inMessages: PokeIn,
      async onMessage(): Promise<HookResult> {
        await new Promise((r) => setTimeout(r, 0));
        return stopPropagation();
      },
      handlers: {
        POKE() {
          handlerRan = true;
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send({ type: "POKE", value: 1 });
    proc.send({ type: "STOP" });

    await proc.wait();
    expect(handlerRan).toBe(false);
  });
});

// ── cascading stop ─────────────────────────────────────────────────────────

describe("cascading stop", () => {
  it("parent awaits children before emitting EXIT", async () => {
    const order: string[] = [];
    const Child = defineActor({
      name: "child",
      beforeEnd() {
        order.push("child:beforeEnd");
      },
      handlers: {},
    });
    const Parent = defineActor({
      name: "parent",
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {},
    });

    const proc = await Parent.spawn({}, {
      toParent: ([msg]: [any, any]) => {
        if (msg.type === "EXIT") order.push("parent:EXIT");
      },
    });
    await proc.ready();
    proc.send({ type: "STOP" });
    await proc.wait();

    expect(order).toEqual(["child:beforeEnd", "parent:EXIT"]);
  });

  it("warns when a child refuses to stop", async () => {
    const Child = defineActor({
      name: "child",
      onStopRequested() {
        // never call agreeToStop — refuse to stop
      },
      handlers: {},
    });
    const Parent = defineActor({
      name: "parent",
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {},
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const proc = await Parent.spawn({});
      await proc.ready();
      proc.send({ type: "STOP" });
      await proc.wait();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('child "parent:child" did not stop'),
      );
    } finally {
      warn.mockRestore();
    }
  });

});
