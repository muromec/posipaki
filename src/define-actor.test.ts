// ── defineActor tests ───────────────────────────────────────────────────────
//
// RED-GREEN-PURPLE-GREEN cycle.
//
// RED:    Test written against normal AsyncProcessFn.  counterFn was undefined.
// GREEN:  counterFn implemented using normal async generator + runDispatchAsync.
// PURPLE: describe.each runs the same expectations against both the normal
//         AsyncProcessFn variant AND a defineActor variant.  The defineActor
//         variant fails — defineActor doesn't exist yet.
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

// ═══════════════════════════════════════════════════════════════════════════════
// Variant A (GREEN): normal AsyncProcessFn
// ═══════════════════════════════════════════════════════════════════════════════

const counterFn_vA: AsyncProcessFn<CounterArgs, CountState, PokeM, CounterOut> =
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
          state.count = args.max;
        }
      },
      () => state.count >= args.max,
    );
  };

// ═══════════════════════════════════════════════════════════════════════════════
// Variant B (PURPLE): defineActor — doesn't exist yet
// ═══════════════════════════════════════════════════════════════════════════════

// defineActor will be imported from the index once implemented.
// For PURPLE phase: undefined — the test suite will fail for this variant.

// @ts-expect-error — PURPLE: defineActor not implemented yet
const counterFn_vB: AsyncProcessFn<CounterArgs, CountState, PokeM, CounterOut> = undefined;

// ═══════════════════════════════════════════════════════════════════════════════
// describe.each — run the same test suite against both variants
// ═══════════════════════════════════════════════════════════════════════════════

describe.each([
  { variant: "A: normal AsyncProcessFn", fn: () => counterFn_vA },
  { variant: "B: defineActor (PURPLE)",  fn: () => counterFn_vB },
])("counter process — $variant", ({ fn }) => {
  // Each test case gets a fresh counter.
  const getFn = fn as () => AsyncProcessFn<CounterArgs, CountState, PokeM, CounterOut>;

  it("starts with count 0", async () => {
    const proc = spawnAsync<CounterArgs, CountState, PokeM, CounterOut>(
      getFn(), "counter",
    )({ max: 3 });

    await proc.ready();
    expect(proc.state).toEqual({ count: 0 });

    proc.send({ type: "STOP" } as Message);
    await proc.wait();
  });

  it("increments count on POKE", async () => {
    const proc = spawnAsync<CounterArgs, CountState, PokeM, CounterOut>(
      getFn(), "counter",
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
      getFn(), "counter",
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
      getFn(), "counter",
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
      getFn(), "my-counter",
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
      getFn(), "counter",
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
