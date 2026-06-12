import { describe, it, expect } from "vitest";
import { watchExit } from "./util";
import type { Message, ExitMessage, ProcessCtx } from "./types";
import type { PingM, PongM } from "./test-helpers.js";

describe("watchExit", () => {

  function* pingPong(_ctx: ProcessCtx<unknown, { seq: number }, PingM, ExitMessage | PongM>) {
    const state = { seq: 0 };
    yield state;
    while (true) {
      const msg: PingM = yield null;
      if (msg.pseq !== state.seq) break;
      state.seq += 1;
    }
  }

  it("sends STOP to children and EXIT to parent when the generator completes", () => {
    const childCalls: Message[] = [];
    const parentCalls: (ExitMessage | PongM)[] = [];

    const proc = {
      id: Symbol("test"),
      pname: "test",
      toAllChildren(m: Message) {
        childCalls.push(m);
      },
      toParent(m: ExitMessage | PongM) {
        parentCalls.push(m);
      },
    };

    const wrapped = watchExit(proc, pingPong);
    const gen = wrapped(
      {
        pname: "test",
        fork: undefined as any,
        send: undefined as any,
        toParent: proc.toParent,
      },
      undefined as any,
    );

    gen.next(); // initial state { seq: 0 }
    gen.next({ type: "PING", pseq: 0 }); // seq becomes 1
    gen.next({ type: "PING", pseq: 99 }); // mismatch → generator exits

    expect(childCalls).toEqual([{ type: "STOP" }]);
    expect(parentCalls).toContainEqual({ type: "EXIT", pid: proc.id, fromName: "test", fromId: proc.id });
  });

  it("does not send STOP or EXIT if the generator never completes", () => {
    const childCalls: Message[] = [];
    const parentCalls: (ExitMessage | PongM)[] = [];

    const proc = {
      id: Symbol("test"),
      pname: "test",
      toAllChildren(m: Message) {
        childCalls.push(m);
      },
      toParent(m: ExitMessage | PongM) {
        parentCalls.push(m);
      },
    };

    function* infinite(_ctx: ProcessCtx<unknown, number, Message, ExitMessage>) {
      let n = 0;
      yield n;
      while (true) {
        n++;
        yield n;
      }
    }

    const wrapped = watchExit(proc, infinite);
    const gen = wrapped(
      {
        pname: "test",
        fork: undefined as any,
        send: undefined as any,
        toParent: proc.toParent,
      },
      undefined as any,
    );

    gen.next(); // initial state
    gen.next({ type: "ANY" } as Message); // still running
    gen.next({ type: "ANY" } as Message); // still running

    expect(childCalls).toEqual([]);
    expect(parentCalls).toEqual([]);
  });
});
