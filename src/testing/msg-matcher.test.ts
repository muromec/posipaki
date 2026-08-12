// ── Message Matcher Tests ────────────────────────────────────────────────
//
// RED PHASE — describes the matcher API before it exists.

import { describe, it, expect } from "vitest";
import type { Message } from "../types.js";

function historyLengthAtLeastThree(_msg: PongMsg, history: PongMsg[]): boolean {
  return history.length >= 3;
}

interface PingMsg extends Message {
  type: "PING";
  n: number;
}
interface PongMsg extends Message {
  type: "PONG";
  n: number;
}

// import { toMatcher } from "./msg-matcher.js";

describe("toMatcher", () => {
  it("matches a single message literal (shallow)", async () => {
    const { toMatcher } = await import("./msg-matcher.js");
    const m = toMatcher<PongMsg>({ type: "PONG" });

    expect(m({ type: "PONG", n: 1 }, [{ type: "PONG", n: 1 }])).toBe(true);
    // shallow: extra fields on the message are ignored
    expect(
      m(
        { type: "PONG", n: 42 } as PongMsg,
        [{ type: "PONG", n: 42 } as PongMsg],
      ),
    ).toBe(true);
    expect(m({ type: "PING", n: 1 } as unknown as PongMsg, [{ type: "PING" } as unknown as PongMsg])).toBe(false);
  });

  it("matches a sequence in order from the tail", async () => {
    const { toMatcher } = await import("./msg-matcher.js");
    const m = toMatcher<PongMsg>([{ type: "PONG", n: 1 }, { type: "PONG", n: 2 }]);

    // history ends with PONG(1), PONG(2) → match
    const hist = [
      { type: "PONG", n: 9 },
      { type: "PONG", n: 1 },
      { type: "PONG", n: 2 },
    ] as PongMsg[];
    expect(m(hist[hist.length - 1], hist)).toBe(true);

    // reversed → no match
    const rev = [
      { type: "PONG", n: 9 },
      { type: "PONG", n: 2 },
      { type: "PONG", n: 1 },
    ] as PongMsg[];
    expect(m(rev[rev.length - 1], rev)).toBe(false);

    // too short → no match
    expect(m({ type: "PONG", n: 2 } as PongMsg, [{ type: "PONG", n: 2 } as PongMsg])).toBe(false);
  });

  it("passes through a function matcher unchanged", async () => {
    const { toMatcher } = await import("./msg-matcher.js");
    const m = toMatcher<PongMsg>(historyLengthAtLeastThree);

    expect(m({ type: "PONG", n: 1 }, [{}, {}, {}] as PongMsg[])).toBe(true);
    expect(m({ type: "PONG", n: 1 }, [{}] as PongMsg[])).toBe(false);
  });

  it("msg is the last element of history", async () => {
    const { toMatcher } = await import("./msg-matcher.js");
    const m = toMatcher<PongMsg>((msg, history) => history[history.length - 1] === msg);

    const last = { type: "PONG", n: 7 } as PongMsg;
    expect(m(last, [{ type: "PONG", n: 1 }, last] as PongMsg[])).toBe(true);
  });
});
