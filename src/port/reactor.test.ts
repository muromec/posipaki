// ── the loop, at the port level ─────────────────────────────────────────────
//
// A listener the test feeds by hand, and memory pairs behind it: what is under test is the loop — one handler per
// accept, in order, the live count, and stop.

import { describe, expect, it } from "vitest";

import type { Channel } from "./channel.js";
import { memoryChannelPair, type MemoryEnd } from "./memory.js";
import { portReactor, type PortPair, type PortListener } from "./reactor.js";

/** A listener the test drives: it hands out pairs it was given, and rejects when closed. */
function handFed<In, Out>(): {
  listener: PortListener<In, Out, string, string>;
  give(meta: string): PortPair<In, Out, string, string>;
} {
  const queue: Array<PortPair<In, Out, string, string>> = [];
  let waiting: ((pair: PortPair<In, Out, string, string>) => void) | null = null;
  let refuse: ((error: Error) => void) | null = null;

  const pair = (meta: string): PortPair<In, Out, string, string> => {
    const inbound = memoryChannelPair<In>();
    const outbound = memoryChannelPair<Out>();
    return { inbound: inbound.far, outbound: outbound.far, meta };
  };

  return {
    listener: {
      accept: () =>
        new Promise<PortPair<In, Out, string, string>>((resolve, reject) => {
          const next = queue.shift();
          if (next !== undefined) return resolve(next);
          waiting = resolve;
          refuse = reject;
        }),
      close: async () => {
        refuse?.(new Error("closed"));
      },
    },
    give(meta: string) {
      const next = pair(meta);
      if (waiting !== null) {
        const resolve = waiting;
        waiting = null;
        resolve(next);
      } else {
        queue.push(next);
      }
      return next;
    },
  };
}

describe("portReactor", () => {
  it("runs one handler per accepted pair, with the meta the listener gave", async () => {
    const fed = handFed<string, string>();
    const seen: string[] = [];
    portReactor(fed.listener, (pair) => {
      seen.push(pair.meta);
    });

    fed.give("first");
    fed.give("second");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(seen).toEqual(["first", "second"]);
    await fed.listener.close();
  });

  it("reports a handler that throws, and keeps the loop", async () => {
    const fed = handFed<string, string>();
    const errors: unknown[] = [];
    const done: string[] = [];
    portReactor(
      fed.listener,
      (pair) => {
        if (pair.meta === "bad") throw new Error("nope");
        done.push(pair.meta);
      },
      { onError: (error) => errors.push(error) },
    );

    fed.give("bad");
    fed.give("good");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(errors).toHaveLength(1);
    expect(done).toEqual(["good"]);
    await fed.listener.close();
  });

  it("stop() closes the listener and waits for the handlers", async () => {
    const fed = handFed<string, string>();
    let finished = false;
    const reactor = portReactor(fed.listener, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    });

    fed.give("running");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await reactor.stop();

    expect(finished).toBe(true);
    expect(reactor.live).toBe(0);
  });
});
