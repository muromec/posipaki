import type { ProcessFn, AsyncProcessFn, Message } from "./types.js"

export function asyncify<A, S, IM extends Message, OM extends Message>(
  fn: ProcessFn<A, S, IM, OM>,
): AsyncProcessFn<A, S, IM, OM> {
  return async function* (ctx, args) {
    yield* fn(ctx, args) as any
  }
}
