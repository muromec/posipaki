// ── what a process says once it has crossed ────────────────────────────────
//
// The stream for a process is three things: what it can answer, what it holds,
// and what it says from then on.  What is checked here is the order it is said
// in — nothing before the frame that carried the reference — and that it stops
// when the connection does.

import { describe, it, expect } from "vitest";
import { defineActor } from "../index.js";
import { ProcessStreams, reflectionNames } from "./process-streams.js";
import { REFLECT_METHODS, isExit, isMsg, isState } from "./channel.js";
import { RemoteProcess } from "./remote-process.js";
import type { Message } from "../types.js";
import { sleep } from "../util.js";

type Ping = { type: "PING" } & Message;

const Echo = defineActor({
  name: "mine",
  $reflectionMethods: {
    async "echo.pings"() {
      return this.state.pings;
    },
  },
  async setup() {
    return { pings: 0 };
  },
  handlers: {
    async PING() {
      this.state.pings += 1;
      this.ctx.notify();
      await this.emit({ type: "PONG" });
    },
  },
});

/** A process that fails while doing its work: what a handle hears about that is
 *  that it is gone, and that it did not finish. */
const Breaks = defineActor({
  name: "breaks",
  handlers: {
    async BOOM() {
      throw new Error("no");
    },
  },
});

function makeStreams() {
  const sent: Array<[Record<string, unknown>, number]> = [];
  const streams = new ProcessStreams((frame, to) => sent.push([frame, to]));
  return { streams, sent };
}

describe("reflectionNames", () => {
  it("is the functions a process offers, and nothing else", () => {
    expect(reflectionNames({ $reflection: { a: () => 1, b: "not a method" } })).toEqual(["a"]);
    expect(reflectionNames({})).toEqual([]);
    expect(reflectionNames({ $reflection: null })).toEqual([]);
  });

  it("reads a process once and answers the same list after that", () => {
    const target: { $reflection?: unknown } = { $reflection: { a: () => 1 } };
    expect(reflectionNames(target)).toEqual(["a"]);

    target.$reflection = { a: () => 1, b: () => 2 };
    expect(reflectionNames(target)).toEqual(["a"]);
  });
});

describe("ProcessStreams", () => {
  it("says nothing about a process until it is flushed, then what it can answer and what it holds", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});

    streams.crossed(mine, 1);
    expect(sent).toEqual([]);

    streams.flush();
    expect(sent.map(([frame, to]) => [frame, to])).toEqual([
      [{ [REFLECT_METHODS]: ["echo.pings"] }, 1],
      [{ $state: { pings: 0 } }, 1],
    ]);

    await mine.stop();
  });

  it("goes on saying what it holds and what it says, under the id it crosses by", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, 3);
    streams.flush();
    sent.length = 0;

    mine.send({ type: "PING" } as Ping);
    await sleep(20);

    expect(sent.some(([frame, to]) => to === 3 && isMsg(frame))).toBe(true);
    const told = sent.find(([frame, to]) => to === 3 && isMsg(frame))?.[0];
    expect(told?.$msg).toEqual({ fromName: "mine", body: { type: "PONG" } });
    const state = sent.filter(([frame, to]) => to === 3 && isState(frame)).pop()?.[0];
    expect(state?.$state).toEqual({ pings: 1 });

    await mine.stop();
  });

  it("says it ended once, as the last thing it says about it", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, 1);
    streams.flush();
    sent.length = 0;

    await mine.stop();
    await sleep(20);

    // Exactly one exit, and nothing after it: what it settles on the way out is
    // said first, and then it is gone.
    expect(sent.filter(([frame]) => isExit(frame))).toEqual([
      [{ $exit: { code: 0, state: { pings: 0 } } }, 1],
    ]);
    expect(isExit(sent[sent.length - 1][0])).toBe(true);
  });

  it("says it ended badly when it fails to run", async () => {
    const { streams, sent } = makeStreams();
    const breaking = await Breaks.spawn({});
    streams.crossed(breaking, 5);
    streams.flush();

    breaking.send({ type: "BOOM" } as Message);
    await sleep(20);

    const exits = sent.filter(([frame, to]) => to === 5 && isExit(frame));
    expect(exits).toEqual([[{ $exit: { code: 1, state: null } }, 5]]);
  });

  it("has nothing to stream for a handle travelling back to its holder", () => {
    const { streams, sent } = makeStreams();

    streams.crossed(new RemoteProcess({ id: 2, pname: "remote:kid" }, () => {}, "here"), 5);
    streams.flush();

    expect(sent).toEqual([]);
  });

  it("says nothing more about any of them once it is stopped", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, 1);
    streams.flush();
    streams.stopAll();
    sent.length = 0;

    mine.send({ type: "PING" } as Ping);
    await sleep(20);

    expect(sent).toEqual([]);

    await mine.stop();
  });
});
