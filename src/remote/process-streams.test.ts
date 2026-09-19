// ── what a process says once it has crossed ────────────────────────────────
//
// The stream for a process is what it can answer, and then as much of what it
// holds, what it says and its end as the far side asked for.  What is checked
// here is that everything said comes after the frame that carried the reference,
// that a process crosses silent and is heard only once something asks, that the
// state is said the moment it is asked for, and that a stream stops when it is
// let go or when the connection does.

import { describe, it, expect } from "vitest";
import { defineActor } from "../index.js";
import { ProcessStreams, reflectionNames } from "./process-streams.js";
import { REFLECT_METHODS, isExit, isMsg, isState } from "./channel.js";
import { rootIdFor } from "./process-ref.js";

/** The id an odd side gives its own root, which is the one the streams do not watch:
 *  its end is the connection's end, and the side that owns the wire says it. */
const ROOT_ID = rootIdFor("odd");
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
  const streams = new ProcessStreams((frame, to) => {
    sent.push([frame, to]);
  }, ROOT_ID);
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
  it("says what it can answer about a process that crossed, and nothing else until it is asked", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});

    streams.crossed(mine, 3);
    expect(sent).toEqual([]);

    streams.flush();
    // What it can answer is not one of the three categories: a handle that cannot
    // name a method can do nothing with the process however much it is told about
    // it, so this crosses even in silence.
    expect(sent).toEqual([[{ [REFLECT_METHODS]: ["echo.pings"] }, 3]]);

    // And nothing it does is said until it is asked for.
    mine.send({ type: "PING" } as Ping);
    await sleep(20);
    expect(sent).toHaveLength(1);

    await mine.stop();
  });

  it("says what it holds the moment it is asked for it", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, 3);
    streams.flush();
    sent.length = 0;

    streams.tune(3, ["state"]);

    // Asked for is said now rather than at the next change: in silence the far
    // side has heard nothing about its state, and a handle that has just asked
    // what it holds has waited long enough.
    expect(sent).toEqual([[{ $state: { pings: 0 } }, 3]]);

    await mine.stop();
  });

  it("goes on saying what it holds and what it says, once both are asked for", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, 3);
    streams.flush();
    streams.tune(3, ["message", "state"]);
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

  it("leaves out what was tuned away, and takes it up again where it stands", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, 3);
    streams.flush();
    streams.tune(3, ["message", "state"]);
    sent.length = 0;

    mine.send({ type: "PING" } as Ping);
    await sleep(20);
    expect(sent.some(([frame]) => isMsg(frame))).toBe(true);
    expect(sent.some(([frame]) => isState(frame))).toBe(true);

    // Silent: neither what it says nor what it holds crosses.
    streams.tune(3, []);
    sent.length = 0;
    mine.send({ type: "PING" } as Ping);
    await sleep(20);
    expect(sent).toEqual([]);

    // Asked for again, it is said from where the process stands now — two pings
    // in, not the state it was in when the stream went quiet.
    streams.tune(3, ["state"]);
    expect(sent).toEqual([[{ $state: { pings: 2 } }, 3]]);

    await mine.stop();
  });

  it("says it ended once, when the end is one of the things asked for", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, 3);
    streams.flush();
    streams.tune(3, ["exit"]);
    sent.length = 0;

    await mine.stop();
    await sleep(20);

    // Exactly one exit, and nothing after it: what it settles on the way out is
    // said first, and then it is gone.
    expect(sent.filter(([frame]) => isExit(frame))).toEqual([
      [{ $exit: { code: 0, state: { pings: 0 } } }, 3],
    ]);
    expect(isExit(sent[sent.length - 1][0])).toBe(true);
  });

  it("says nothing of an end nobody asked for", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, 3);
    streams.flush();
    sent.length = 0;

    await mine.stop();
    await sleep(20);

    // Silence is silence: a process that crossed unheard ends unheard, which is
    // the price of asking for nothing.
    expect(sent).toEqual([]);
  });

  it("says it ended badly when it fails to run, if the end was asked for", async () => {
    const { streams, sent } = makeStreams();
    const breaking = await Breaks.spawn({});
    streams.crossed(breaking, 5);
    streams.flush();
    streams.tune(5, ["exit"]);

    breaking.send({ type: "BOOM" } as Message);
    await sleep(20);

    const exits = sent.filter(([frame, to]) => to === 5 && isExit(frame));
    expect(exits).toEqual([[{ $exit: { code: 1, state: null } }, 5]]);
  });

  it("says about the root of the connection what it is asked for, like anything else", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, ROOT_ID);
    streams.flush();

    // Announced, and nothing else: the root crosses silent as a process does, and a
    // side that wants to hear it asks — which is what a visitor's proxy does.
    expect(sent).toEqual([[{ [REFLECT_METHODS]: ["echo.pings"] }, ROOT_ID]]);

    streams.tune(ROOT_ID, ["message", "state"]);
    expect(sent).toEqual([
      [{ [REFLECT_METHODS]: ["echo.pings"] }, ROOT_ID],
      [{ $state: { pings: 0 } }, ROOT_ID],
    ]);

    sent.length = 0;
    mine.send({ type: "PING" } as Ping);
    await sleep(20);
    expect(sent.some(([frame, to]) => to === ROOT_ID && isMsg(frame))).toBe(true);
    expect(sent.some(([frame, to]) => to === ROOT_ID && isState(frame))).toBe(true);

    await mine.stop();
  });

  it("leaves the root's end to the side that owns the wire, and watches no other", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, ROOT_ID);
    streams.flush();
    streams.tune(ROOT_ID, ["exit"]);

    await mine.stop();
    await sleep(20);

    // No watch on it, so no exit on its own: the side that owns the wire says that,
    // awaited, as it takes the wire down.
    expect(sent.filter(([, to]) => to === ROOT_ID).some(([frame]) => isExit(frame))).toBe(false);

    // And what it does say is said by `sayEnded`, once.
    await streams.sayEnded(ROOT_ID, 0);
    expect(sent.filter(([frame, to]) => to === ROOT_ID && isExit(frame))).toEqual([
      [{ $exit: { code: 0, state: mine.state } }, ROOT_ID],
    ]);
    await streams.sayEnded(ROOT_ID, 0);
    expect(sent.filter(([frame, to]) => to === ROOT_ID && isExit(frame))).toHaveLength(1);
  });

  it("has nothing to stream for a handle travelling back to its holder", () => {
    const { streams, sent } = makeStreams();

    streams.crossed(new RemoteProcess({ id: 2, pname: "remote:kid" }, () => {}, "here"), 5);
    streams.flush();

    expect(sent).toEqual([]);
  });

  it("has nothing to tune for an id it does not stream", () => {
    const { streams, sent } = makeStreams();

    streams.tune(7, ["state", "exit"]);

    expect(sent).toEqual([]);
  });

  it("says nothing more about one it is told to let go, and nothing of its end", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, 3);
    streams.flush();
    streams.tune(3, ["message", "state", "exit"]);
    streams.stop(3);
    sent.length = 0;

    mine.send({ type: "PING" } as Ping);
    await mine.stop();
    await sleep(20);

    // Neither what it did nor the fact that it is gone: it is out of this
    // connection's hands, and its end is nobody's news here.
    expect(sent).toEqual([]);
  });

  it("says nothing more about any of them once it is stopped", async () => {
    const { streams, sent } = makeStreams();
    const mine = await Echo.spawn({});
    streams.crossed(mine, 3);
    streams.flush();
    streams.tune(3, ["message", "state", "exit"]);
    streams.stopAll();
    sent.length = 0;

    mine.send({ type: "PING" } as Ping);
    await sleep(20);

    expect(sent).toEqual([]);

    await mine.stop();
  });
});
