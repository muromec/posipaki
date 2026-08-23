// ── Lifecycle Hooks Tests ───────────────────────────────────────────────
//
// Tests for defineActor hooks: onMessage, onEmit, onChildExit, onError,
// onStart, beforeEnd, onStopRequested, and stopPropagation().

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorPlugin } from './actor-type.js';
import { defineActor, defineMessages } from "./define-actor.js";
import { stopPropagation, mergeConfigs, type HookResult } from "./hooks.js";
import { withTimeout } from './util.js';
import type { Message, SenderInfo } from "./types.js";
import { nextState } from './testing/';

vi.mocked = vi.mocked || ((v) => v);
vi.mock('./util.js', async (importOriginal) => {
  let actual = {}
  if (importOriginal) {
    actual = await importOriginal();
  }
  const withTimeoutMock = vi.fn().mockImplementation((p) => p);
  return { ...actual, withTimeout: withTimeoutMock };
});

function withTimeoutMiss() {
  return vi.mocked(withTimeout).mockRejectedValueOnce(new Error('Timeout:stop'));
}
function withTimeoutHit() {
  return vi.mocked(withTimeout).mockImplementation((p) => p);
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
    proc.send({ type: "POKE", value: 1 });
    await proc.stop();

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
    proc.send(
      { type: "POKE", value: 1 },
      { fromName: "caller", fromId: Symbol("caller") },
    );
    await proc.stop();

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
    proc.send({ type: "POKE", value: 1 });
    await proc.stop();

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
    proc.send({ type: "POKE", value: 1 });
    await proc.stop();

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
    await proc.stop();

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
    const plugin1 : ActorPlugin = (cfg) => mergeConfigs(cfg, {
      afterStart() {
        order.push("plugin");
      },
    });

    const Actor = defineActor({
      name: "test",
      afterStart() {
        order.push("actor");
      },
      plugins: [plugin1],
      handlers: {},
    });

    const proc = await Actor.spawn({});
    await proc.stop();

    expect(order).toEqual(["plugin", "actor"]);
  });

  it("plugin beforeEnd fires before actor beforeEnd", async () => {
    const order: string[] = [];
    const plugin2 : ActorPlugin = (cfg) => mergeConfigs(cfg, {
      beforeEnd() {
        order.push("plugin");
      },
    });

    const Actor = defineActor({
      name: "test",
      beforeEnd() {
        order.push("actor");
      },
      plugins: [plugin2],
      handlers: {},
    });

    const proc = await Actor.spawn({});
    await proc.stop();

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
        order.push(msg.type);
      },
    });
    await proc.stop();

    expect(order).toEqual(["beforeEnd", "EXIT", "afterEnd"]);
  });
});

// ── onStopRequested ordering (plugin chain via mergeConfigs) ─────────────

describe("hooks.onStopRequested", () => {
  it("plugin onStopRequested fires before actor onStopRequested", async () => {
    const order: string[] = [];
    const plugin3 : ActorPlugin = (cfg) => mergeConfigs(cfg, {
      onStopRequested() {
        order.push("plugin");
      },
    });

    const Actor = defineActor({
      name: "test",
      onStopRequested() {
        order.push("actor");
        this.agreeToStop();
      },
      plugins: [plugin3],
      handlers: {},
    });

    const proc = await Actor.spawn({});
    await proc.stop();

    expect(order).toEqual(["plugin", "actor"]);
  });
});

// ── onError hooks ────────────────────────────────────────────────────────

describe("hooks.onError", () => {
  it("fires when a handler throws and prevents actor from crashing", async () => {
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
    proc.send({ type: "POKE", value: 1 });
    proc.send({ type: "POKE", value: 10 });
    await proc.stop();

    expect(capturedError).toBe("BOOM");
    // both 1 and 10 were processed
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
    proc.send({ type: "POKE", value: 1 });
    proc.send({ type: "POKE", value: 10 });

    await expect(proc.wait()).rejects.toThrow();
    // second message was not processed
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
    proc.send({ type: "POKE", value: 1 });
    proc.send({ type: "POKE", value: 10 });
    await proc.stop();
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
    proc.send({ type: "POKE", value: 1 });
    await proc.stop();
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
    await proc.stop();

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
      afterEnd() {
        order.push("child:afterEnd");
      },
      handlers: {},
    });
    const Parent = defineActor({
      name: "parent",
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      beforeEnd() {
        order.push("parent:beforeEnd");
      },
      afterEnd() {
        order.push("parent:afterEnd");
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.stop();

    expect(order).toEqual([
      "parent:beforeEnd",
      "child:beforeEnd",
      "child:afterEnd",
      "parent:afterEnd",
    ]);
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
      // FIXME: this should be the same as await proc.stop()
      // but its not!
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
    expect(proc.orphans.length).toBe(0);

    // Child self-exits; its grandchild refuses to stop (1s cascade timeout), so
    // Parent collects the survivor into its orphans. Await the child's own
    // completion rather than sleeping.
    const child = proc.children[0];
    const grandChild = child.children[0];
    await child.wait();
    expect(proc.orphans.length).toBe(1);
    expect(proc.orphans[0].id).toBe(grandChild.id);
    await proc.stop();
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
    expect(proc.orphans.length).toBe(0);

    // Child self-exits; its grandchild refuses to stop (1s cascade timeout), so
    // Parent collects the survivor into its orphans. Await the child's own
    // completion rather than sleeping.
    const child = proc.children[0];
    await child.wait();
    expect(proc.orphans.length).toBe(0);
    await proc.stop();
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
    expect(child.pname).toBe('parent:child');
    await child.wait();

    // before parent processed the message
    // orphans are kept in the temporary map
    expect(proc.orphans.length).toBe(1);

    // wait for parent process exit message
    await nextState(proc);

    expect(proc.orphans.length).toBe(0);
    expect(proc.children.map((c) => c.pname)).toContain("parent:child:grandchild");
    await proc.stop();
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

    expect(proc.orphans.length).toBe(1);
    await nextState(proc);
    expect(proc.orphans.length).toBe(0);

    await proc.stop();
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

    // No onOrphan → the orphan is hard-killed and removed.

    expect(proc.orphans.length).toBe(1);
    await nextState(proc);
    expect(proc.orphans.length).toBe(0);

    await proc.stop();
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

    // keep the grandchild after child exit
    // is processed
    expect(proc.orphans.length).toBe(1);
    await nextState(proc);
    expect(proc.orphans.length).toBe(1);
    expect(proc.orphans.map((o) => o.pname)).toEqual(["parent:child:grandchild"]);

    await proc.stop();
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

    // Buffer dropped but the orphan keeps running, still accounted for.
    // FIXME: this does not check the buffer is removed

    expect(proc.orphans.length).toBe(1);
    await nextState(proc);
    expect(proc.orphans.length).toBe(1);
    expect(proc.orphans.map((o) => o.pname)).toEqual(["parent:child:grandchild"]);

    await proc.stop();
  });
});


// ── orphan handoff (lossless adopt) ──────────────────────────────────────

describe("orphan handoff (lossless adopt)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

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
      inMessages: HandoffIn,
      async setup() {
        await this.fork(Grandchild, undefined, {});
        return {};
      },
      afterStart() {
        this.exit();
      },
      handlers: {
        HANDOFF(msg) {
          received.push('never');
        },
      },
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

    expect(received).toEqual([]);
 
    // let parent process the exit which
    // adopts the orphan and empties the buffered
    // out-queue of the grand-child into parent inbox
    await nextState(proc);
    await proc.stop();

    expect(received).toEqual([42]);
    expect(proc.orphans.length).toBe(0);
    expect(proc.children.map((c) => c.pname)).toContain(
      "parent:child:grandchild",
    );
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
    withTimeoutMiss(); // parent's cascade: adopted grandchild refuses

    const order: string[] = [];

    const Grandchild = defineActor({
      name: "grandchild",
      outMessages: HandoffOut,
      async onStopRequested() {
        await this.emit({ type: "HANDOFF", value: 7 });
        emitted = true;
        order.push('gc:emit');
      },
      handlers: {},
    });
    const Child = defineActor({
      name: "child",
      outMessages: HandoffOut,
      inMessages: HandoffIn,

      async setup() {
        await this.fork(Grandchild, undefined, {});
        return {};
      },
      afterStart() {
        this.exit();
        order.push('child:after-start');
      },
      beforeEnd() {
        order.push('child:before-end');
      },
      afterEnd() {
        order.push('child:after-end');
      },
      handlers: {
        HANDOFF(msg) {
          order.push('child:msg'); // never hits
        },
      },
    });
    const Parent = defineActor({
      name: "parent",
      inMessages: HandoffIn,
      onOrphan() {
        order.push('parent:adopt');
        return "adopt";
      },
      async setup() {
        await this.fork(Child, undefined, {});
        return {};
      },
      handlers: {
        HANDOFF(msg) {
          order.push('parent:msg:'+ msg.value); // never hits
        },
      },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    const child = proc.children[0];
    const grandChild = child.children[0];
    // Wait until the grandchild has processed STOP and emitted into the child's
    // still-live inbox, then release the cascade timeout so the child finishes
    // exiting (and back-feeds the message to the adopting parent).

    await nextState(grandChild);
    release!();
    await child.wait();

    await nextState(proc);
    await proc.stop();

    expect(order).toEqual([
      'child:after-start',
      'child:before-end',
      'gc:emit',
      'child:after-end',
      'parent:adopt',
      'parent:msg:7',
    ]);

  });

  it("drains an orphan that self-stops while unowned (its EXIT lands in the collector)", async () => {
    withTimeoutMiss(); // child's cascade: grandchild refuses → orphaned

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
      async onOrphan(orphan) {
        orphan.send({ type: "DIE"});
        await orphan.wait();
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

    expect(proc.orphans.length).toBe(1);

    // Parent is now holding onOrphan at the gate: the grandchild is unowned and
    // its collector is buffering. Make it self-stop so its EXIT lands in the
    // collector's buffer rather than reaching anyone in real time.
    await nextState(proc);
    expect(proc.orphans.length).toBe(0);

    // The drained EXIT removed the (dead) orphan from children and fired
    // onChildExit for it — the handoff closes cleanly.
    expect(proc.children.length).toBe(0);
    expect(proc.orphans.length).toBe(0);
    expect(exitedNames).toContain("parent:child:grandchild");

    await proc.stop();
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
    handlers: {},
  });

  async function runTree(decision: "unparent" | "leave") {
    /*
    This spawns a tree of four actors:
    grand parent (gg), parent, child, grandchild.

    child (depth=3) exits, but grandchild (depth=4)
    refuses and is handed over to parent as orphan.

    Depending on the decision parent (depth=2) makes,
    messages emitted by grandchild either reach grandparent
    or not.
    */
    const Parent = defineActor({
      name: "parent",
      onOrphan() {
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
        return { pong: false };
      },
      handlers: {
        PONG() {
          this.state.pong = true;
        },
      },
    });

    const gg = await GrandParent.spawn({});
    await gg.ready();
    const parent = gg.children[0];
    const child = parent.children[0];
    const grandchild = child.children[0];

    // everything is started
    expect(parent.children.length).toBe(1);

    // wait for child to exit on start and
    // grandchild to end up as 
    await child.stop();
    await nextState(parent);
    expect(parent.children.length).toBe(0);
    expect(parent.orphans.length).toBe(1);
    expect(parent.orphans[0]).toBe(grandchild);

    // Parent has made its decision; ping the still-orphaned grandchild, then
    // stop Parent so the grandchild bubbles up and the grandparent adopts it.
    grandchild.send({ type: "PING" });
    parent.send({ type: "STOP"} );
    await nextState(gg);

    expect(gg.children.length).toBe(1);
    expect(gg.orphans.length).toBe(0);

    // grandparent (d=1) adopted the grandchild (d=4)
    expect(gg.children[0]).toBe(grandchild);

    return gg;
  }

  it("unparent drops the orphan's in-flight buffer", async () => {
    withTimeoutMiss(); // child's cascade
    withTimeoutMiss(); // parent's cascade
    withTimeoutMiss(); // grandparent's cascade (adopted grandchild refuses)
    withTimeoutMiss();

    const gg = await runTree("unparent");
    expect(gg.state.pong).toBe(false);
    await gg.stop();
  });

  it("leave preserves the orphan's in-flight buffer", async () => {
    withTimeoutMiss(); // child's cascade
    withTimeoutMiss(); // parent's cascade
    withTimeoutMiss(); // grandparent's cascade (adopted grandchild refuses)
    withTimeoutMiss();

    const gg = await runTree("leave");
    expect(gg.state.pong).toBe(true);
    await gg.stop();
  });
});
