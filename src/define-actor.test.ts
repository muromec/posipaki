// ── defineActor tests ───────────────────────────────────────────────────────
//
// RED-GREEN-PURPLE-GREEN cycle.
//
// RED:    Test written against normal AsyncProcessFn.  counterFn was undefined.
// GREEN:  counterFn implemented using normal async generator + runDispatchAsync.
// PURPLE: describe.each runs the same expectations against both the normal
//         AsyncProcessFn variant AND a defineActor variant.  defineActor
//         didn't exist yet — variant B failed.
// FINAL GREEN: Implement defineActor.  Both variants PASS.
//
// Run:  npx vitest run src/define-actor.test.ts

import { describe, it, expect } from "vitest";
import { spawnAsync, runDispatchAsync, defineActor } from "./index.js";
import type {
  AsyncProcessFn,
  Message,
  WithSender,
  ProcessCtx,
} from "./index.js";

import type { PokeM } from "./test-helpers.js";
import { defineMessages } from "./define-actor.js";
import { nextState, nextMessage } from "./testing";

// ═══════════════════════════════════════════════════════════════════════════════
// Shared types
// ═══════════════════════════════════════════════════════════════════════════════

type CounterIn = PokeM | { type: "STOP" } | { type: "PING"; count: number };
type CountState = { count: number; max: number; name: string };
type CounterArgs = { max: number };
type DoneMessage = { type: "DONE"; count: number };
type CounterOut =  DoneMessage | Message;

// ═══════════════════════════════════════════════════════════════════════════════
// Variant A (GREEN): normal async generator — ctx param carries the types
// ═══════════════════════════════════════════════════════════════════════════════

const counterFn_vA = async function* counterFn(
  ctx: ProcessCtx<CounterArgs, CountState, CounterIn, CounterOut>,
  args: CounterArgs,
) {
  const state: CountState = { count: 0, max: args.max, name: ctx.pname };
  yield state;

  yield* runDispatchAsync<WithSender<CounterIn>>(
    ctx.pname,
    async ([msg]) => {
      if (msg.type === "POKE") {
        state.count++;
        if (state.count >= state.max) {
          ctx.toParent({ type: "DONE", count: state.count });
        }
      }
      if (msg.type === "STOP") {
        state.count = state.max;
      }
    },
    () => state.count >= state.max,
  );
  ctx.toParent({ type: "EXIT"});
};

// ═══════════════════════════════════════════════════════════════════════════════
// Variant B (FINAL GREEN): defineActor
// ═══════════════════════════════════════════════════════════════════════════════

const counterDef_vB = defineActor({
  setup(args: CounterArgs): CountState {
    return { count: 0, max: args.max, name: this.name } as CountState;
  },
  outMessages: defineMessages<CounterOut>(),
  inMessages: defineMessages<CounterIn>(),
  methods: {
    increment() {
      this.state.count++;
    },
    beDone() {
      this.emit({ type: "DONE", count: this.state.count });
      this.exit("max reached");
    },
  },

  handlers: {
    PING(msg) {
      void msg.count;
    },
    POKE(msg) {
      this.increment();
      if (this.state.count >= this.state.max) {
        this.beDone();
      }
    },
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// describe.each — run the same test suite against both variants
// ═══════════════════════════════════════════════════════════════════════════════

describe.each([
  { variant: "A: normal async generator", fn: () => counterFn_vA },
  { variant: "B: defineActor", fn: () => counterDef_vB.fn },
])("counter process — $variant", ({ fn }) => {
  const getFn = fn as () => AsyncProcessFn<
    CounterArgs,
    CountState,
    CounterIn,
    CounterOut
  >;

  it("starts with count 0", async () => {
    const proc = spawnAsync<CounterArgs, CountState, CounterIn, CounterOut>(
      getFn(),
      "counter",
    )({ max: 3 });

    await proc.ready();
    expect(proc.state).toEqual({ count: 0, max: 3, name: "counter" });
    await proc.stop();
  });

  it("increments count on POKE", async () => {
    const proc = spawnAsync<CounterArgs, CountState, CounterIn, CounterOut>(
      getFn(),
      "counter",
    )({ max: 3 });

    await proc.ready();
    proc.send({ type: "POKE" });

    expect(await nextState(proc)).toMatchObject({ count: 1 });

    await proc.stop();
  });

  it("increments multiple times", async () => {
    const proc = spawnAsync<CounterArgs, CountState, CounterIn, CounterOut>(
      getFn(),
      "counter",
    )({ max: 5 });

    await proc.ready();
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });

    expect(await nextState(proc)).toMatchObject({ count: 3 });

    await proc.stop();
  });

  it("exits when count reaches max, ignoring further POKEs", async () => {
    const proc = spawnAsync<CounterArgs, CountState, CounterIn, CounterOut>(
      getFn(),
      "counter",
    )({ max: 2 });

    await proc.ready();
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" });
    proc.send({ type: "POKE" }); // dropped — exit condition already met

    await proc.wait();
    expect(proc.state!.count).toBe(2);
  });

  it("exposes process name and id", async () => {
    const proc = spawnAsync<CounterArgs, CountState, CounterIn, CounterOut>(
      getFn(),
      "my-counter",
    )({ max: 1 });

    await proc.ready();
    expect(proc.pname).toBe("my-counter");
    expect(typeof proc.id).toBe("symbol");
    expect(proc.id.toString()).toBe("Symbol(my-counter)");

    proc.send({ type: "POKE" });
    await proc.wait();
  });

  it("emits DONE to parent with final count", async () => {
    const proc = spawnAsync<CounterArgs, CountState, CounterIn, CounterOut>(
      getFn(),
      "counter",
    )({ max: 1 });

    await proc.ready();
    proc.send({ type: "POKE" });
    expect(await nextMessage(proc)).toMatchObject({ type: "DONE", count: 1});
    await proc.wait();
  });
});


// ── spawn with opts ───────────────────────────────────────────────────

describe('spawn with opts', () => {
  it('delivers emitted messages to toParent callback', async () => {
    const actor = defineActor({
      outMessages: defineMessages<DoneMessage>(),
      setup: () => ({ sent: false }),
      handlers: {
        POKE() {
          this.emit({ type: 'DONE', count: 1 });
        },
      },
    });

    const received: DoneMessage[] = [];
    const proc = await actor.spawn({}, {
      toParent: (msg) => { received.push(msg); },
    });

    await proc.ready();
    proc.send({ type: 'POKE' });
    await proc.stop();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].type).toBe('DONE');
    expect(received[0].count).toBe(1);
  });

  it('works without opts (backward compatible)', async () => {
    const actor = defineActor({
      setup: () => ({ x: 0 }),
      handlers: {
        POKE(this) { this.state.x = 1; },
      },
    });

    const proc = await actor.spawn({});
    await proc.ready();
    proc.send({ type: 'POKE' });
    await proc.stop();

    expect(proc.state!.x).toBe(1);
  });
});
