import { AsyncProcess } from "./process.async.js";
import { asyncify } from "./adapters.js";
import type { Message, ExitMessage, ProcessFn } from "./types.js";

export type { Message, ProcessFn, ProcessCtx } from "./types.js";
export { runDispatch } from "./util.js";

export function spawn<
  A,
  S,
  IM extends Message = Message,
  OM extends Message = ExitMessage,
>(
  fn: ProcessFn<A, S, IM, OM>,
  pname: string,
  tp?: (m: OM) => void,
): (a: A) => Process<A, S, IM, OM> {
  return (a: A) => new Process(fn, pname, tp).start(a) as Process<A, S, IM, OM>;
}

class Process<
  A,
  S,
  IM extends Message,
  OM extends Message,
> extends AsyncProcess<A, S, IM, OM> {
  constructor(
    fn: ProcessFn<A, S, IM, OM>,
    pname: string,
    tp?: (m: OM) => void,
  ) {
    super(asyncify(fn), pname, tp);
  }

  start(a: A) {
    super.start(a);
    return this;
  }
  tick(): Promise<void> {
    return super._tick();
  }
}

export { Process };
