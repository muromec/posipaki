// ── defineActor tests ───────────────────────────────────────────────────────
//
// RED-GREEN-PURPLE-GREEN cycle.
//
// RED:    Test written against normal AsyncProcessFn.  counterFn was undefined.
// GREEN:  counterFn implemented using normal async generator + runDispatchAsync.
// PURPLE: describe.each runs the same expectations against defineActor
//         (which doesn't exist yet — PURPLE variant FAILS).
// FINAL GREEN: Implement defineActor.  Both variants PASS.
//
// Run:  npx vitest run src/define-actor.test.ts

import { describe, it, expect } from "vitest";
import { spawnAsync, runDispatchAsync } from "./index.js";
import type { AsyncProcessFn, Message, ProcessCtx } from "./index.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Shared types
// ═══════════════════════════════════════════════════════════════════════════════

type PokeM = { type: "POKE" };
type CountState = { count: number };
type CounterArgs = { max: number };
type CounterOut = { type: "DONE"; count: number } | Message;

// Helper: wait for the async tick to flush by sending a benign message.
// The process processes the POKE, updates state, then the next message
// (STOP) arrives and triggers exit.  We check state after tick, before
// stopping.
async function tickAndStop(proc: ReturnType<typeof spawnAsync>, check: () => void) {
  // Give the async tick time to process.
  await new Promise(r => setTimeout(r, 50));
  check();
  proc.send({ type: "STOP" } as Message);
  await proc.wait();
}

// ═══════════════════════════════════════════════════════════════════════════════
// GREEN phase — real implementation using normal async generator
// ═══════════════════════════════════════════════════════════════════════════════

const counterFn: AsyncProcessFn<CounterArgs, CountState, PokeM, CounterOut> =
  async function* counterFn(
    ctx: ProcessCtx<CounterArgs, CountState, PokeM, CounterOut>,
    args: CounterArgs,
  ) {
    const state: CountState = { count: 0 };
    yield state;

    yield* runDispatchAsync(
      ctx.pname,
      async (msg) => {
        if (msg.type === "POKE") {
          state.count++;
          if (state.count >= args.max) {
            ctx.toParent({ type: "DONE", count: state.count });
          }
        }
        if (msg.type === "STOP") {
          // Force exit on STOP — set count past max so readyFn returns true.
          state.count = args.max;
        }
      },
      () => state.count >= args.max,
    );
  };

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("GREEN: counter process (normal AsyncProcessFn)", () => {
  it("starts with count 0", async () => {
    const proc = spawnAsync<CounterArgs, CountState, PokeM, CounterOut>(
      counterFn, "counter",
    )({ max: 3 });

    await proc.ready();
    expect(proc.state).toEqual({ count: 0 });

    proc.send({ type: "STOP" } as Message);
    await proc.wait();
  });

  it("increments count on POKE", async () => {
    const proc = spawnAsync<CounterArgs, CountState, PokeM, CounterOut>(
      counterFn, "counter",
    )({ max: 3 });

    await proc.ready();
    proc.send({ type: "POKE" });
    await new Promise(r => setTimeout(r, 50));

    expect(proc.state).toEqual({ count: 1 });

    proc.send({ type: "STOP" } as Message);
    await proc.wait();
  });

  it("increments multiple times", async () => {
    const proc = spawnAsync<CounterArgs, CountState, PokeM, CounterOut>(
      counterFn, "counter",
    )({ max: 5 });

    await proc.ready();
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });
    await new Promise(r => setTimeout(r, 50));

    expect(proc.state).toEqual({ count: 3 });

    proc.send({ type: "STOP" } as Message);
    await proc.wait();
  });

  it("exits when count reaches max, ignoring further POKEs", async () => {
    const proc = spawnAsync<CounterArgs, CountState, PokeM, CounterOut>(
      counterFn, "counter",
    )({ max: 2 });

    await proc.ready();
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" }); // dropped — exit condition already met

    await proc.wait();
    expect(proc.state?.count).toBe(2);
  });

  it("exposes process name and id", async () => {
    const proc = spawnAsync<CounterArgs, CountState, PokeM, CounterOut>(
      counterFn, "my-counter",
    )({ max: 1 });

    await proc.ready();
    expect(proc.pname).toBe("my-counter");
    expect(typeof proc.id).toBe("symbol");
    expect(proc.id.toString()).toBe("Symbol(my-counter)");

    proc.send({ type: "POKE" });
    await proc.wait();
  });

  it("emits DONE to parent with final count", async () => {
    const messages: CounterOut[] = [];
    const proc = spawnAsync<CounterArgs, CountState, PokeM, CounterOut>(
      counterFn, "counter",
      (msg) => messages.push(msg),
    )({ max: 1 });

    await proc.ready();
    proc.send({ type: "POKE" });
    await proc.wait();

    const doneMsg = messages.find(m => m.type === "DONE") as
      { type: "DONE"; count: number } | undefined;
    expect(doneMsg).toBeDefined();
    expect(doneMsg!.count).toBe(1);
  });
});
