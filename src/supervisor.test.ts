import { describe, it, expect, vi } from "vitest";
import { spawn, runDispatch } from "./index";
import { supervise, attach } from "./supervisor";
import type { SupervisorState } from "./supervisor";
import type { ProcessCtx, ProcessFn, Message, WithSender } from "./types";

type ChildArgs = { n: number };
type ChildState = { n: number; done: boolean };

function* child(
  { pname }: ProcessCtx<unknown, ChildState, Message, Message>,
  args: unknown,
): Generator<ChildState | null, void, WithSender<Message>> {
  const state: ChildState = { n: (args as ChildArgs).n, done: false };
  yield state;
  yield* runDispatch(
    pname,
    ([msg]) => {
      if (msg.type === "DONE" || msg.type === "STOP") state.done = true;
    },
    () => state.done,
    false,
  );
}

const superviseFn = supervise as unknown as ProcessFn<
  unknown,
  SupervisorState,
  Message,
  Message
>;

const identity = (s: unknown): unknown => s;

describe("supervisor", () => {
  it("starts in the wait phase with no processes", async () => {
    const sup = spawn(superviseFn, "sup")(identity);
    await sup.ready();
    expect(sup.state).toMatchObject({ phase: "wait", processes: [] });
  });

  it("defaults the state wrapper to identity when none is given", async () => {
    const sup = spawn(superviseFn, "sup-default-wrap")(undefined);
    await sup.ready();
    expect(sup.state).toMatchObject({ phase: "wait", processes: [] });
  });

  it("RUN forks a child and moves to the running phase", async () => {
    const sup = spawn(superviseFn, "sup-run")(identity);
    await sup.ready();
    attach(sup as never, child, "child-1")({ n: 42 });
    await sup.tick();
    expect(sup.state).toMatchObject({ phase: "running" });
    expect(sup.children).toHaveLength(1);
    expect(sup.children[0].pname).toBe("child-1");
    sup.send({ type: "STOP" }, { fromName: "test", fromId: Symbol("test") });
    await sup.wait();
  });

  it("EXIT from a child is absorbed without changing phase", async () => {
    const sup = spawn(superviseFn, "sup-exit")(identity);
    await sup.ready();
    attach(sup as never, child, "child-1")({ n: 1 });
    await sup.tick();
    const childProc = sup.children[0];
    childProc.send({ type: "DONE" }, { fromName: "test", fromId: Symbol("test") });
    await childProc.wait();
    expect(sup.children).toHaveLength(0);
    expect(sup.state).toMatchObject({ phase: "running" });
    sup.send({ type: "STOP" }, { fromName: "test", fromId: Symbol("test") });
    await sup.wait();
  });

  it("forwards OK from a child to its parent", async () => {
    const bus = vi.fn();
    const sup = spawn(superviseFn, "sup-ok", bus)(identity);
    await sup.ready();
    const okMsg = { type: "OK", value: 7 } as unknown as Message;
    sup.send(okMsg, { fromName: "child", fromId: Symbol("child") });
    await sup.tick();
    expect(bus).toHaveBeenCalledWith(
      expect.objectContaining({ type: "OK", value: 7 }),
      expect.any(Object),
    );
  });

  it("STOP sets the stopping phase and the supervisor exits", async () => {
    const sup = spawn(superviseFn, "sup-stop")(identity);
    await sup.ready();
    sup.send({ type: "STOP" }, { fromName: "test", fromId: Symbol("test") });
    await sup.wait();
    expect(sup.state).toMatchObject({ phase: "stopping" });
  });
});
