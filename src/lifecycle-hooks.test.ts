// ── Lifecycle Hooks Tests ───────────────────────────────────────────────
//
// Tests for defineActor hooks: onMessage, onEmit, onChildExit, onError,
// onStart, beforeEnd, onStopRequested, and stopPropagation().

import { describe, it, expect, vi } from "vitest";
import { defineActor, defineMessages } from "./define-actor.js";
import { stopPropagation, mergeConfigs, type HookResult } from "./hooks.js";
import { withTimeout } from './util.js';
import type { Message, SenderInfo } from "./types.js";

vi.mock('./util.js', async (importOriginal) => {
  let actual = {}
  if (importOriginal) {
    actual = await importOriginal();
  }
  const withTimeoutMock = vi.fn().mockImplementation((p) => p);
  return { ...actual, withTimeout: withTimeoutMock };
});

function withTimeoutMiss() {
  vi.mocked(withTimeout).mockRejectedValueOnce(new Error('Timeout:stop'));
}
function withTimeoutHit() {
  vi.mocked(withTimeout).mockImplementation((p) => p);
}

/** Let a process's dispatch loop process a message (EXIT) already in its inbox. */
async function settle() {
  await new Promise((r) => setTimeout(r, 20));
}

/** Poll until `fn` is truthy, throwing after `timeoutMs` (deterministic waits). */
async function until(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("until: condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

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
      toParent: (msg) => {
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
    withTimeoutHit();
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
      toParent: (msg) => {
        if (msg.type === "EXIT") order.push("parent:EXIT");
      },
    });
    await proc.ready();
    proc.send({ type: "STOP" });
    await proc.wait();

    expect(order).toEqual(["child:beforeEnd", "parent:EXIT"]);
  });

  it("warns when a child refuses to stop", async () => {
    withTimeoutMiss();

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

describe("orphans", () => {

  it("collects a surviving grandchild into the parent's orphans", async () => {
    withTimeoutMiss();

    const Grandchild = defineActor({
      name: "grandchild",
      onStopRequested() {
        // never call agreeToStop — refuse to stop
      },
      handlers: {},
    });
    const Child = defineActor({
      name: "child",
      async setup() {
        await this.fork(Grandchild, undefined, {});
        return {};
      },
      afterStart() {
        this.exit();
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

    const proc = await Parent.spawn({});
    await proc.ready();
    // Child self-exits; its grandchild refuses to stop (1s cascade timeout), so
    // Parent collects the survivor into its orphans. Await the child's own
    // completion rather than sleeping.
    const child = proc.children[0];
    await child.wait();
    expect(proc.orphans.map((o) => o.pname)).toEqual(["parent:child:grandchild"]);
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("keeps orphan list empty if all children exit on time", async () => {
    withTimeoutHit();
    const Grandchild = defineActor({
      name: "grandchild",
      handlers: {},
    });
    const Child = defineActor({
      name: "child",
      async setup() {
        await this.fork(Grandchild, undefined, {});
        return {};
      },
      afterStart() {
        this.exit();
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

    const proc = await Parent.spawn({});
    await proc.ready();
    // Child self-exits; its grandchild refuses to stop (1s cascade timeout), so
    // Parent collects the survivor into its orphans. Await the child's own
    // completion rather than sleeping.
    const child = proc.children[0];
    await child.wait();
    expect(proc.orphans.map((o) => o.pname)).toEqual([]);
    proc.send({ type: "STOP" });
    await proc.wait();
  });
});

describe("orphan policy (onOrphan)", () => {
  const Grandchild = defineActor({
    name: "grandchild",
    onStopRequested() {
      // never agree to stop — refuse
    },
    handlers: {},
  });
  const Child = defineActor({
    name: "child",
    async setup() {
      await this.fork(Grandchild, undefined, {});
      return {};
    },
    afterStart() {
      this.exit();
    },
    handlers: {},
  });

  it("adopts an orphan via onOrphan 'adopt'", async () => {
    withTimeoutMiss(); // child's cascade: grandchild refuses → orphaned
    withTimeoutMiss(); // parent's cascade: adopted grandchild refuses → orphaned again
    const Parent = defineActor({
      name: "parent",
      onOrphan() {
        return "adopt";
      },
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    const child = proc.children[0];
    await child.wait();
    await settle();

    expect(proc.orphans.length).toBe(0);
    expect(proc.children.map((c) => c.pname)).toContain("parent:child:grandchild");
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("force-stops an orphan via onOrphan 'force-stop'", async () => {
    withTimeoutMiss();
    const Parent = defineActor({
      name: "parent",
      onOrphan() {
        return "force-stop";
      },
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    const child = proc.children[0];
    await child.wait();
    await settle();

    expect(proc.orphans.length).toBe(0);
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("force-stops an orphan by default (no onOrphan)", async () => {
    withTimeoutMiss();
    const Parent = defineActor({
      name: "parent",
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    const child = proc.children[0];
    await child.wait();
    await settle();

    // No onOrphan → the orphan is hard-killed and removed.
    expect(proc.orphans.length).toBe(0);
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("leaves an orphan via onOrphan 'leave'", async () => {
    withTimeoutMiss();
    const Parent = defineActor({
      name: "parent",
      onOrphan() {
        return "leave";
      },
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    const child = proc.children[0];
    await child.wait();
    await settle();

    expect(proc.orphans.map((o) => o.pname)).toEqual(["parent:child:grandchild"]);
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("unparents an orphan via onOrphan 'unparent'", async () => {
    withTimeoutMiss();
    const Parent = defineActor({
      name: "parent",
      onOrphan() {
        return "unparent";
      },
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    const child = proc.children[0];
    await child.wait();
    await settle();

    // Buffer dropped but the orphan keeps running, still accounted for.
    expect(proc.orphans.map((o) => o.pname)).toEqual(["parent:child:grandchild"]);
    proc.send({ type: "STOP" });
    await proc.wait();
  });
});


// ── orphan handoff (lossless adopt) ──────────────────────────────────────

describe("orphan handoff (lossless adopt)", () => {
  interface HandoffMsg extends Message {
    type: "HANDOFF";
    value: number;
  }
  const HandoffIn = defineMessages<HandoffMsg>();
  const HandoffOut = defineMessages<HandoffMsg>();

  it("recovers a message the orphan emits during the handoff window", async () => {
    withTimeoutMiss(); // child's cascade: grandchild refuses → orphaned
    withTimeoutMiss(); // parent's cascade: adopted grandchild refuses → orphaned again

    const received: number[] = [];

    const Grandchild = defineActor({
      name: "grandchild",
      outMessages: HandoffOut,
      onStopRequested() {
        // Emitted while processing STOP, which happens *after* the child has
        // installed its collector — so this lands in the collector's buffer.
        this.emit({ type: "HANDOFF", value: 42 });
        // (do not call agreeToStop — refuse to stop)
      },
      handlers: {},
    });
    const Child = defineActor({
      name: "child",
      outMessages: HandoffOut,
      async setup() {
        await this.fork(Grandchild, undefined, {});
        return {};
      },
      afterStart() {
        this.exit();
      },
      handlers: {},
    });
    const Parent = defineActor({
      name: "parent",
      inMessages: HandoffIn,
      onOrphan() {
        return "adopt";
      },
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {
        HANDOFF(msg) {
          received.push(msg.value);
        },
      },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    const child = proc.children[0];
    await child.wait();
    await settle();

    expect(received).toEqual([42]);
    expect(proc.orphans.length).toBe(0);
    expect(proc.children.map((c) => c.pname)).toContain(
      "parent:child:grandchild",
    );
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("back-feeds a message the orphan emitted into the dying parent's inbox", async () => {
    // The child's cascade hangs on a *controlled* timeout so the grandchild can
    // emit while the child is still subscribed — the message lands in the
    // child's inbox (Window A) and is recovered by back-feed, not the collector.
    let release: (() => void) | null = null;
    let emitted = false;
    vi.mocked(withTimeout).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          release = () => reject(new Error("Timeout:stop"));
        }),
    );
    withTimeoutMiss(); // parent's cascade: adopted grandchild refuses

    const received: number[] = [];

    const Grandchild = defineActor({
      name: "grandchild",
      outMessages: HandoffOut,
      async onStopRequested() {
        await this.emit({ type: "HANDOFF", value: 7 });
        emitted = true;
      },
      handlers: {},
    });
    const Child = defineActor({
      name: "child",
      outMessages: HandoffOut,
      async setup() {
        await this.fork(Grandchild, undefined, {});
        return {};
      },
      afterStart() {
        this.exit();
      },
      handlers: {},
    });
    const Parent = defineActor({
      name: "parent",
      inMessages: HandoffIn,
      onOrphan() {
        return "adopt";
      },
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {
        HANDOFF(msg) {
          received.push(msg.value);
        },
      },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    const child = proc.children[0];
    // Wait until the grandchild has processed STOP and emitted into the child's
    // still-live inbox, then release the cascade timeout so the child finishes
    // exiting (and back-feeds the message to the adopting parent).
    await until(() => emitted);
    release!();
    await child.wait();
    await settle();

    expect(received).toEqual([7]);
    proc.send({ type: "STOP" });
    await proc.wait();
  });

  it("drains an orphan that self-stops while unowned (its EXIT lands in the collector)", async () => {
    withTimeoutMiss(); // child's cascade: grandchild refuses → orphaned

    let gateReached = false;
    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const exitedNames: string[] = [];

    const Grandchild = defineActor({
      name: "grandchild",
      onStopRequested() {
        // refuse to stop (no agreeToStop) — this is what orphans it
      },
      handlers: {
        DIE() {
          this.exit();
        },
      },
    });
    const Child = defineActor({
      name: "child",
      async setup() {
        await this.fork(Grandchild, undefined, {});
        return {};
      },
      afterStart() {
        this.exit();
      },
      handlers: {},
    });
    const Parent = defineActor({
      name: "parent",
      async onOrphan() {
        gateReached = true;
        await gate; // hold the orphan unowned while we make it self-stop
        return "adopt" as const;
      },
      onChildExit(name) {
        exitedNames.push(name);
      },
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    const child = proc.children[0];
    await child.wait();
    // Parent is now holding onOrphan at the gate: the grandchild is unowned and
    // its collector is buffering. Make it self-stop so its EXIT lands in the
    // collector's buffer rather than reaching anyone in real time.
    await until(() => gateReached);
    const gc = proc.orphans[0];
    gc.send({ type: "DIE" });
    await gc.wait();

    releaseGate!();
    await settle();

    // The drained EXIT removed the (dead) orphan from children and fired
    // onChildExit for it — the handoff closes cleanly.
    expect(proc.children.map((c) => c.pname)).not.toContain(
      "parent:child:grandchild",
    );
    expect(proc.orphans.length).toBe(0);
    expect(exitedNames).toContain("parent:child:grandchild");

    proc.send({ type: "STOP" });
    await proc.wait();
  });
});


// ── orphan policy: buffer drop (unparent vs leave) ───────────────────────

describe("orphan policy: buffer drop (unparent vs leave)", () => {
  interface PongMsg extends Message {
    type: "PONG";
  }
  const PongOut = defineMessages<PongMsg>();

  const Grandchild = defineActor({
    name: "grandchild",
    outMessages: PongOut,
    onStopRequested() {
      // refuse to stop — this is what orphans it
    },
    handlers: {
      PING() {
        this.emit({ type: "PONG" });
      },
    },
  });
  const Child = defineActor({
    name: "child",
    async setup() {
      await this.fork(Grandchild, undefined, {});
      return {};
    },
    afterStart() {
      this.exit();
    },
    handlers: {},
  });

  async function runTree(decision: "unparent" | "leave") {
    let pDecided = false;
    let receivedPong = false;

    const Parent = defineActor({
      name: "parent",
      onOrphan() {
        pDecided = true;
        return decision;
      },
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {},
    });
    const GrandParent = defineActor({
      name: "grandparent",
      onOrphan() {
        return "adopt";
      },
      async setup() {
        await this.fork(Parent, undefined, {});
        return {};
      },
      handlers: {
        PONG() {
          receivedPong = true;
        },
      },
    });

    const gg = await GrandParent.spawn({});
    await gg.ready();
    const parent = gg.children[0];
    await until(() => pDecided);
    // Parent has made its decision; ping the still-orphaned grandchild, then
    // stop Parent so the grandchild bubbles up and the grandparent adopts it.
    const gc = parent.orphans[0];
    gc.send({ type: "PING" });
    await settle();
    parent.send({ type: "STOP" });
    await parent.wait();
    await settle();

    return { gg, receivedPong };
  }

  it("unparent drops the orphan's in-flight buffer", async () => {
    withTimeoutMiss(); // child's cascade
    withTimeoutMiss(); // grandparent's cascade (adopted grandchild refuses)
    const { gg, receivedPong } = await runTree("unparent");
    expect(receivedPong).toBe(false);
    gg.send({ type: "STOP" });
    await gg.wait();
  });

  it("leave preserves the orphan's in-flight buffer", async () => {
    withTimeoutMiss();
    withTimeoutMiss();
    const { gg, receivedPong } = await runTree("leave");
    expect(receivedPong).toBe(true);
    gg.send({ type: "STOP" });
    await gg.wait();
  });
});
