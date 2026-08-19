/* eslint-disable unicorn/consistent-function-scoping */
import { describe, it, expect, vi } from "vitest";
import { runDispatch } from "./index";
import { spawnAsync, asyncify, runDispatchAsync } from "./index";
import type { ProcessCtx, Message, WithSender, AsyncProcessFn } from "./index";

import type { ExitMessage } from "./util";

import type { PokeM, CountStore } from "./test-helpers.js";

describe("AsyncProcess", () => {
  // ---- basic lifecycle ------------------------------------------------------

  it("should expose initial state from an async generator", async () => {
    async function* p1() {
      yield { count: 0 } as CountStore;
    }

    const proc = spawnAsync(p1, "counter")(null);
    await proc.ready();
    expect(proc.state).toEqual({ count: 0 });
    await proc.wait();
  });

  it("should process messages via runDispatchAsync and update state", async () => {
    const fn = async function* (
      { pname }: ProcessCtx<null, CountStore, PokeM, Message>,
    ) {
      const state: CountStore = { count: 0 };
      yield state;

      yield* runDispatchAsync<WithSender<Message | PokeM>>(
        pname,
        async (maybe) => {
          const [msg, _s] = maybe;
          if (msg.type === "POKE") state.count++;
        },
        () => state.count >= 2,
      );
    };

    const proc = spawnAsync(fn, "counter")(null);
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });

    await proc.wait();
    expect(proc.state?.count).toBe(2);
  });

  it("should wait for an async timer inside a reducer", async () => {
    const fn = async function* (
      { pname }: ProcessCtx<null, { fired: boolean }, PokeM, Message>,
    ) {
      const state = { fired: false };
      yield state;

      yield* runDispatchAsync<WithSender<Message | PokeM>>(
        pname,
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          state.fired = true;
        },
        () => state.fired,
      );
    };

    const proc = spawnAsync(fn, "timer")(null);
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });

    await proc.wait();
    expect(proc.state).toEqual({ fired: true });
  });

  it("should notify subscribers after an async tick", async () => {
    const callback = vi.fn();

    const fn = async function* (
      { pname }: ProcessCtx<null, CountStore, PokeM, Message>,
    ) {
      const state: CountStore = { count: 0 };
      yield state;

      yield* runDispatchAsync<WithSender<Message | PokeM>>(
        pname,
        async () => {
          state.count++;
        },
        () => state.count >= 1,
      );
    };

    const proc = spawnAsync(fn, "counter")(null);
    proc.subscribe(callback);
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });

    await proc.wait();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  // ---- exit behaviour -------------------------------------------------------

  it("should send EXIT to parent on completion", async () => {
    const bus = vi.fn();

    const fn = async function* (
      _ctx: ProcessCtx<null, null, Message, ExitMessage | Message>,
    ) {
      yield null;
    };

    const proc = spawnAsync(fn, "exiter", bus)(null);
    await proc.wait();

    expect(bus).toHaveBeenCalledWith(
      expect.objectContaining({ type: "EXIT" }), expect.any(Object),
    );
  });

  // ---- asyncify: wrap a sync generator for async spawn ----------------------

  it("should run a sync generator via asyncify", async () => {
    function* syncFn(
      { pname }: ProcessCtx<unknown, { count: number }, PokeM, Message>,
    ) {
      const state = { count: 0 };
      yield state;
      yield* runDispatch(
        pname,
        (maybe: any) => {
          const [msg, _s] = maybe;
          if (msg.type === "POKE") state.count++;
        },
        () => state.count >= 2,
      );
    }

    const proc = spawnAsync(asyncify(syncFn), "wrapped")(null);
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });

    await proc.wait();
    expect(proc.state).toEqual({ count: 2 });
  });

  it("should run a sync generator via asyncify with a single message", async () => {
    function* syncFn(
      { pname }: ProcessCtx<unknown, { count: number }, PokeM, Message>,
    ) {
      const state = { count: 0 };
      yield state;
      yield* runDispatch(
        pname,
        (maybe: any) => {
          const [msg, _s] = maybe;
          if (msg.type === "POKE") state.count++;
        },
        () => state.count >= 1,
      );
    }

    const proc = spawnAsync(asyncify(syncFn), "single")(null);
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });

    await proc.wait();
    expect(proc.state).toEqual({ count: 1 });
  });

  // ---- pause / resume -------------------------------------------------------

  it("should buffer messages while paused and process them on resume", async () => {
    const fn = async function* (
      { pname }: ProcessCtx<null, { hits: number }, PokeM, Message>,
    ) {
      const state = { hits: 0 };
      yield state;

      yield* runDispatchAsync<WithSender<Message | PokeM>>(
        pname,
        async () => {
          state.hits++;
        },
        () => state.hits >= 2,
      );
    };

    const proc = spawnAsync(fn, "pausable")(null);
    proc.pause();
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });

    await vi.waitFor(() => expect(proc.state).toEqual({ hits: 0 }), {
      timeout: 100,
    });

    proc.resume();
    await proc.wait();

    expect(proc.state).toEqual({ hits: 2 });
  });

  // ---- concurrency guard ----------------------------------------------------

  it("should never allow concurrent ticks on the same generator", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const fn = async function* (
      { pname }: ProcessCtx<null, { count: number }, PokeM, Message>,
    ) {
      const state = { count: 0 };
      yield state;

      yield* runDispatchAsync<WithSender<Message | PokeM>>(
        pname,
        async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 10));
          state.count++;
          concurrent--;
        },
        () => state.count >= 3,
      );
    };

    const proc = spawnAsync(fn, "concurrent")(null);
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });

    await proc.wait();
    expect(proc.state).toEqual({ count: 3 });
    expect(maxConcurrent).toBe(1);
  });

  // ---- error propagation ----------------------------------------------------

  it("should propagate errors from an async reducer to wait()", async () => {
    const fn = async function* (
      { pname }: ProcessCtx<null, null, PokeM, Message>,
    ) {
      yield null;
      yield* runDispatchAsync<WithSender<Message>>(pname, async () => {
        throw new Error("boom");
      });
    };

    const proc = spawnAsync(fn, "exploder")(null);
    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });

    await expect(proc.wait()).rejects.toThrow("boom");
  });

  // ---- message ordering with mixed delays ----------------------------------

  it("should process messages in order even when some have delays", async () => {
    type OrderMsg =
      | { type: "START" }
      | { type: "LONG" }
      | { type: "SHORT" };

    const fn = async function* (
      { pname }: ProcessCtx<null, { trace: string }, OrderMsg, Message>,
    ) {
      const state = { trace: "" };
      yield state;

      yield* runDispatchAsync<WithSender<Message | OrderMsg>>(
        pname,
        async (maybe) => {
          const [msg, _s] = maybe;
          if (msg.type === "START") {
            state.trace += "START";
          }
          if (msg.type === "LONG") {
            await new Promise((r) => setTimeout(r, 200));
            state.trace += "-LONG";
          }
          if (msg.type === "SHORT") {
            state.trace += "-SHORT";
          }
        },
        () => state.trace === "START-LONG-SHORT",
      );
    };

    const proc = spawnAsync(fn, "order-test")(null);
    proc.send({ type: "START" }, { fromName: "test", fromId: Symbol("test") });
    proc.send({ type: "LONG" }, { fromName: "test", fromId: Symbol("test") });
    proc.send({ type: "SHORT" }, { fromName: "test", fromId: Symbol("test") });

    await proc.wait();
    expect(proc.state?.trace).toBe("START-LONG-SHORT");
  });
});

describe("message channel & linking", () => {
  type PokeM = { type: "POKE" };
  type PongM = { type: "PONG"; pseq: number };

  // A child that emits PONG when poked, then exits.
  const childFn: AsyncProcessFn<null, null, PokeM, PongM> = async function* (ctx) {
    yield null;
    const [msg, _sender] = yield null;
    if (msg.type === "POKE") ctx.toParent({ type: "PONG", pseq: 1 });
  };

  it("subscribe('message') receives (msg, from) on ctx.toParent", async () => {
    const proc = spawnAsync(childFn, "emitter")(null);
    await proc.ready();

    const cb = vi.fn();
    proc.subscribe("message", cb);

    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });
    await proc.wait();

    expect(cb).toHaveBeenCalledWith(
      { type: "PONG", pseq: 1 },
      expect.objectContaining({ fromName: "emitter" }),
    );
    // EXIT is also emitted through the same channel.
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ type: "EXIT" }),
      expect.objectContaining({ fromName: "emitter" }),
    );
  });

  it("subscribe('state') fires a no-arg ping on state change", async () => {
    const fn: AsyncProcessFn<null, CountStore, PokeM, Message> = async function* (ctx) {
      const state = { count: 0 };
      yield state;
      const [msg, _sender] = yield null;
      if (msg.type === "POKE") state.count++;
    };
    const proc = spawnAsync(fn, "statey")(null);
    await proc.ready();

    const cb = vi.fn();
    proc.subscribe("state", cb);

    proc.send({ type: "POKE" }, { fromName: "test", fromId: Symbol("test") });
    await proc.wait();

    expect(cb).toHaveBeenCalled();
  });

  it("monitor() routes messages without ownership (EXIT does not touch children)", async () => {
    const child = spawnAsync(childFn, "child")(null);
    await child.ready();

    const parentFn: AsyncProcessFn<null, CountStore, PongM | Message, Message> = async function* (ctx) {
      const state = { count: 0 };
      yield state;
      yield* runDispatchAsync<WithSender<Message | PongM>>(
        "parent",
        async ([msg]) => {
          if (msg.type === "PONG") state.count++;
        },
        () => state.count >= 1,
      );
    };
    const parent = spawnAsync(parentFn, "parent")(null);
    await parent.ready();
    parent.monitor(child);

    child.send({ type: "POKE" }, { fromName: "t", fromId: Symbol("t") });
    await parent.wait();

    expect(parent.state?.count).toBe(1);
    // monitored (not adopted): never registered as a child
    expect(parent.children.length).toBe(0);
  });

  it("adopt() claims ownership: child EXIT removes it from children", async () => {
    const child = spawnAsync(childFn, "child")(null);
    await child.ready();

    const parentFn: AsyncProcessFn<null, CountStore, PongM | Message, Message> = async function* (ctx) {
      const state = { count: 0 };
      yield state;
      ctx.adopt(child);
      yield* runDispatchAsync<WithSender<Message | PongM>>(
        "parent",
        async ([msg]) => {
          if (msg.type === "PONG") state.count++;
        },
        () => ctx.children.length === 0 && state.count >= 1,
      );
    };
    const parent = spawnAsync(parentFn, "parent")(null);
    await parent.ready();
    expect(parent.children.length).toBe(1);

    child.send({ type: "POKE" }, { fromName: "t", fromId: Symbol("t") });
    await parent.wait();

    expect(parent.children.length).toBe(0);
    expect(parent.state?.count).toBe(1);
  });

  it("exiting parent unsubscribes from an adopted child", async () => {
    const child = spawnAsync(childFn, "child")(null);
    await child.ready();

    const unsubSpy = vi.fn();
    const realSubscribe = child.subscribe.bind(child);
    vi.spyOn(child, "subscribe").mockImplementation(((
      channel: string,
      cb: unknown,
    ) => {
      if (channel === "message") return unsubSpy;
      return realSubscribe(channel as "state", cb as () => void);
    }) as never);

    const parentFn: AsyncProcessFn<null, null, Message, Message> = async function* (ctx) {
      yield null;
      ctx.adopt(child);
      const [msg, _sender] = yield null; // wait for STOP
    };
    const parent = spawnAsync(parentFn, "parent")(null);
    await parent.ready();

    parent.send({ type: "STOP" });
    await parent.wait();

    expect(unsubSpy).toHaveBeenCalledTimes(1);
  });
});

describe("forceStop", () => {
  type PokeM = { type: "POKE" };

  // An idle process: yields state, then waits forever for a message.
  const idleFn: AsyncProcessFn<null, null, PokeM, Message> = async function* (ctx) {
    yield null;
    const [msg, _sender] = yield null;
    if (msg.type === "POKE") ctx.toParent({ type: "PONG", pseq: 1 } as never);
  };

  it("resolves wait() and does not emit EXIT (finally never runs)", async () => {
    const proc = spawnAsync(idleFn, "victim")(null);
    await proc.ready();

    const emitted: string[] = [];
    proc.subscribe("message", (msg) => emitted.push(msg.type));

    proc.forceStop();
    await proc.wait();

    expect(emitted).toEqual([]);
  });

  it("makes send() a no-op after kill", async () => {
    const proc = spawnAsync(idleFn, "victim")(null);
    await proc.ready();

    proc.forceStop();
    expect(() =>
      proc.send({ type: "POKE" }, { fromName: "t", fromId: Symbol("t") }),
    ).not.toThrow();
    await proc.wait();
  });

  it("is idempotent", async () => {
    const proc = spawnAsync(idleFn, "victim")(null);
    await proc.ready();
    proc.forceStop();
    proc.forceStop();
    await proc.wait();
  });

  it("unsubscribes from a monitored child", async () => {
    const child = spawnAsync(idleFn, "child")(null);
    await child.ready();

    // Spy on child.subscribe before the parent monitors it, so the parent's
    // monitor() captures our unsubSpy as its subscription handle.
    const unsubSpy = vi.fn();
    const realSubscribe = child.subscribe.bind(child);
    vi.spyOn(child, "subscribe").mockImplementation(((
      channel: string,
      cb: unknown,
    ) => {
      if (channel === "message") return unsubSpy;
      return realSubscribe(channel as "state", cb as () => void);
    }) as never);

    const parentFn: AsyncProcessFn<null, null, Message, Message> = async function* (ctx) {
      yield null;
      ctx.monitor(child);
      const [msg, _sender] = yield null; // wait forever
    };
    const parent = spawnAsync(parentFn, "parent")(null);
    await parent.ready();

    parent.forceStop();
    await parent.wait();
    expect(unsubSpy).toHaveBeenCalledTimes(1);
  });
});

describe("stop", () => {
  type PokeM = { type: "POKE" };

  // Exits after processing a single message (STOP or POKE).
  const quittable: AsyncProcessFn<null, null, PokeM, Message> = async function* (ctx) {
    yield null;
    const [msg, _sender] = yield null;
    if (msg.type === "POKE") ctx.toParent({ type: "PONG", pseq: 1 } as never);
  };

  // Never exits — ignores every message.
  const stubborn: AsyncProcessFn<null, null, PokeM, Message> = async function* () {
    yield null;
    while (true) yield null;
  };

  it("resolves true when the process exits gracefully", async () => {
    const proc = spawnAsync(quittable, "quittable")(null);
    await proc.ready();
    await expect(proc.stop()).resolves.toBe(true);
  });

  it("returns false when a non-forced process refuses to stop", async () => {
    const proc = spawnAsync(stubborn, "stubborn")(null);
    await proc.ready();
    await expect(proc.stop()).resolves.toBe(false);
    // Clean up so the stubborn process doesn't linger.
    proc.forceStop();
    await proc.wait();
  });

  it("force-kills a refusing process and returns true", async () => {
    const proc = spawnAsync(stubborn, "stubborn")(null);
    await proc.ready();
    await expect(proc.stop({ force: true })).resolves.toBe(true);
    await proc.wait();
  });
});
