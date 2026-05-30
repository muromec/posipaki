import { describe, it, expect, vi } from "vitest";
import { runDispatch } from "./index";
import { spawnAsync, asyncify, runDispatchAsync } from "./index";
import type { ProcessCtx, Message, AsyncProcessFn } from "./index";
import type { ExitMessage } from "./util";

describe("AsyncProcess", () => {
  type PokeM = { type: "POKE" };
  type CountStore = { count: number };
  type Nil = null;

  // ---- basic lifecycle ------------------------------------------------------

  it("should expose initial state from an async generator", async () => {
    const fn: AsyncProcessFn<Nil, CountStore, Message, Message> =
      async function* () {
        const state: CountStore = { count: 0 };
        yield state;
      };

    const proc = spawnAsync(fn, "counter")(null);
    await vi.waitFor(() => expect(proc.state).toEqual({ count: 0 }), {
      timeout: 100,
    });
    await proc.wait();
  });

  it("should process messages via runDispatchAsync and update state", async () => {
    const fn: AsyncProcessFn<Nil, CountStore, PokeM, Message> =
      async function* ({ pname }) {
        const state: CountStore = { count: 0 };
        yield state;

        yield* runDispatchAsync<Message | PokeM>(
          pname,
          async (msg: any) => {
            if (msg.type === "POKE") state.count++;
          },
          () => state.count >= 2,
        );
      };

    const proc = spawnAsync(fn, "counter")(null);
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });

    await proc.wait();
    expect(proc.state?.count).toBe(2);
  });

  it("should wait for an async timer inside a reducer", async () => {
    const fn: AsyncProcessFn<Nil, { fired: boolean }, PokeM, Message> =
      async function* ({ pname }) {
        const state = { fired: false };
        yield state;

        yield* runDispatchAsync<Message | PokeM>(
          pname,
          async () => {
            await new Promise((r) => setTimeout(r, 10));
            state.fired = true;
          },
          () => state.fired,
        );
      };

    const proc = spawnAsync(fn, "timer")(null);
    proc.send({ type: "POKE" });

    await proc.wait();
    expect(proc.state).toEqual({ fired: true });
  });

  it("should notify subscribers after an async tick", async () => {
    const callback = vi.fn();

    const fn: AsyncProcessFn<Nil, CountStore, PokeM, Message> =
      async function* ({ pname }) {
        const state: CountStore = { count: 0 };
        yield state;

        yield* runDispatchAsync<Message | PokeM>(
          pname,
          async () => {
            state.count++;
          },
          () => state.count >= 1,
        );
      };

    const proc = spawnAsync(fn, "counter")(null);
    proc.subscribe(callback);
    proc.send({ type: "POKE" });

    await proc.wait();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  // ---- exit behaviour -------------------------------------------------------

  it("should send EXIT to parent on completion", async () => {
    const bus = vi.fn();

    const fn: AsyncProcessFn<Nil, null, Message, ExitMessage | Message> =
      async function* () {
        yield null;
      };

    const proc = spawnAsync(fn, "exiter", bus)(null);
    await proc.wait();

    expect(bus).toHaveBeenCalledWith(
      expect.objectContaining({ type: "EXIT", pid: proc.id }),
    );
  });

  // ---- asyncify: wrap a sync generator for async spawn ----------------------

  it("should run a sync generator via asyncify", async () => {
    function* syncFn({ pname }: ProcessCtx<PokeM, Message>) {
      const state = { count: 0 };
      yield state;
      yield* runDispatch(
        pname,
        (msg: any) => {
          if (msg.type === "POKE") state.count++;
        },
        () => state.count >= 2,
      );
    }

    const proc = spawnAsync(asyncify(syncFn), "wrapped")(null);
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });

    await proc.wait();
    expect(proc.state).toEqual({ count: 2 });
  });

  it("should auto-wrap a sync function passed directly to spawnAsync", async () => {
    function* syncFn({ pname }: ProcessCtx<PokeM, Message>) {
      const state = { count: 0 };
      yield state;
      yield* runDispatch(
        pname,
        (msg: any) => {
          if (msg.type === "POKE") state.count++;
        },
        () => state.count >= 1,
      );
    }

    // No asyncify — spawnAsync should detect and wrap it
    const proc = spawnAsync(syncFn, "auto")(null);
    proc.send({ type: "POKE" });

    await proc.wait();
    expect(proc.state).toEqual({ count: 1 });
  });

  // ---- pause / resume -------------------------------------------------------

  it("should buffer messages while paused and process them on resume", async () => {
    const fn: AsyncProcessFn<Nil, { hits: number }, PokeM, Message> =
      async function* ({ pname }) {
        const state = { hits: 0 };
        yield state;

        yield* runDispatchAsync<Message | PokeM>(
          pname,
          async () => {
            state.hits++;
          },
          () => state.hits >= 2,
        );
      };

    const proc = spawnAsync(fn, "pausable")(null);
    proc.pause();
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });

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

    const fn: AsyncProcessFn<Nil, { count: number }, PokeM, Message> =
      async function* ({ pname }) {
        const state = { count: 0 };
        yield state;

        yield* runDispatchAsync<Message | PokeM>(
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
    // Fire multiple messages quickly — they should queue, not overlap
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });

    await proc.wait();
    expect(proc.state).toEqual({ count: 3 });
    expect(maxConcurrent).toBe(1);
  });

  // ---- error propagation ----------------------------------------------------

  it("should propagate errors from an async reducer to wait()", async () => {
    const fn: AsyncProcessFn<Nil, null, PokeM, Message> = async function* ({
      pname,
    }) {
      yield null;
      yield* runDispatchAsync<Message>(pname, async () => {
        throw new Error("boom");
      });
    };

    const proc = spawnAsync(fn, "exploder")(null);
    proc.send({ type: "POKE" });

    await expect(proc.wait()).rejects.toThrow("boom");
  });

  // ---- message ordering with mixed delays ----------------------------------

  it("should process messages in order even when some have delays", async () => {
    type OrderMsg = { type: "START" } | { type: "LONG" } | { type: "SHORT" };

    const fn: AsyncProcessFn<null, { trace: string }, OrderMsg, Message> =
      async function* ({ pname }) {
        const state = { trace: "" };
        yield state;

        yield* runDispatchAsync<Message | OrderMsg>(
          pname,
          async (msg) => {
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
    proc.send({ type: "START" });
    proc.send({ type: "LONG" });
    proc.send({ type: "SHORT" });

    await proc.wait();
    expect(proc.state?.trace).toBe("START-LONG-SHORT");
  });
});
