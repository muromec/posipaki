import type { AsyncProcess } from "../process.async.js";
import type { Message } from "../types.js";

export function nextState<A, S, IM extends Message, OM extends Message, R extends object>(
  proc: AsyncProcess<A, S, IM, OM, R>,
) {
  return new Promise((resolve) => {
    const unsub = proc.subscribe("state", () => {
      unsub();
      resolve(proc.state);
    });
  });
}

export function nextMessage<A, S, IM extends Message, OM extends Message, R extends object>(
  proc: AsyncProcess<A, S, IM, OM, R>,
) {
  return new Promise((resolve) => {
    const unsub = proc.subscribe("message", (msg) => {
      unsub();
      resolve(msg);
    });
  });
}
