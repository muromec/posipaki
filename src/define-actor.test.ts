// ── defineActor tests ───────────────────────────────────────────────────────
//
// RED-GREEN-PURPLE-GREEN cycle.
//
// RED:    Test written against normal AsyncProcessFn.  The process function
//         doesn't exist — counterFn is undefined.  Test FAILS.
// GREEN:  Implement counterFn using normal async generator + runDispatchAsync.
// PURPLE: describe.each runs the same expectations against defineActor
//         (which doesn't exist yet — PURPLE variant FAILS).
// FINAL GREEN: Implement defineActor.  Both variants PASS.
//
// Run:  npx vitest run src/define-actor.test.ts

import { describe, it, expect } from "vitest";
import { spawnAsync, runDispatchAsync } from "./index.js";
import type { AsyncProcessFn, Message } from "./index.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Shared types
// ═══════════════════════════════════════════════════════════════════════════════

type PokeM = { type: "POKE" };
type CountState = { count: number };
type CounterArgs = { max: number };
type CounterOut = { type: "DONE"; count: number } | Message;

// ═══════════════════════════════════════════════════════════════════════════════
// RED phase — test behaviour, counterFn is undefined → FAILS
// ═══════════════════════════════════════════════════════════════════════════════

// The process function — undefined for RED phase.
// @ts-expect-error — intentional: RED phase, not implemented yet
const counterFn: AsyncProcessFn<CounterArgs, CountState, PokeM, CounterOut> = undefined;

describe("RED: counter process (normal AsyncProcessFn)", () => {
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
    await proc.wait();

    expect(proc.state).toEqual({ count: 1 });
  });

  it("increments multiple times", async () => {
    const proc = spawnAsync<CounterArgs, CountState, PokeM, CounterOut>(
      counterFn, "counter",
    )({ max: 5 });

    await proc.ready();
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });

    await proc.wait();
    expect(proc.state).toEqual({ count: 3 });
  });

  it("exits when count reaches max, ignoring further POKEs", async () => {
    const proc = spawnAsync<CounterArgs, CountState, PokeM, CounterOut>(
      counterFn, "counter",
    )({ max: 2 });

    await proc.ready();
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });
    // This POKE should be dropped — exit condition already met.
    proc.send({ type: "POKE" });

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
