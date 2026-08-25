import { describe, it, expect } from "vitest";
import { spawn } from "./index";
import { pipe } from "./pipe";
import type { ProcessCtx, Message, WithSender } from "./types";

type NumArgs = { value: number };
type NumState = { result: { value: number } };

function* double(
  _ctx: ProcessCtx<unknown, NumState, Message, Message>,
  args: unknown,
): Generator<NumState, void, WithSender<Message>> {
  const n = (args as NumArgs).value;
  yield { result: { value: n * 2 } };
}

function* inc(
  _ctx: ProcessCtx<unknown, NumState, Message, Message>,
  args: unknown,
): Generator<NumState, void, WithSender<Message>> {
  const n = (args as NumArgs).value;
  yield { result: { value: n + 1 } };
}

describe("pipe", () => {
  it("starts with the initial params and no result", async () => {
    const proc = spawn(pipe([double, inc]), "pipe-init")({ value: 1 });
    await proc.ready();
    expect(proc.state).toMatchObject({ params: { value: 1 }, result: null });
  });

  it("chains two fns, feeding each result into the next params", async () => {
    const proc = spawn(pipe([double, inc]), "pipe-two")({ value: 1 });
    await proc.ready();
    await proc.wait();
    expect(proc.state).toMatchObject({ running: false, result: { value: 3 } });
  });

  it("chains three fns in order", async () => {
    const proc = spawn(pipe([double, inc, double]), "pipe-three")({ value: 1 });
    await proc.ready();
    await proc.wait();
    expect(proc.state).toMatchObject({ running: false, result: { value: 6 } });
  });

  it("stops on STOP and drops params", async () => {
    const proc = spawn(pipe([double, inc]), "pipe-stop")({ value: 1 });
    await proc.ready();
    proc.send({ type: "STOP" }, { fromName: "test", fromId: Symbol("test") });
    await proc.wait();
    expect(proc.state).toMatchObject({ running: false, params: null });
  });
});
