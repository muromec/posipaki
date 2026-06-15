import { runDispatch } from "./util.js";
import type { ExitMessage } from "./util.js";
import type { ProcessFn, ProcessCtx } from "./process.js";
import type { AsyncProcess } from "./process.async.js";
import type { Message, WithSender, SenderInfo } from "./types.js";

/**
 * State yielded by the pipe process. `params` starts as a copy of the
 * initial args and is updated after each child exits by merging the
 * child's `state.result` into it.
 */
export interface PipeState<Params, Result> {
  params: Params | null;
  result: Result | null;
  running: boolean;
}

/**
 * Chain process functions so each runs after the previous one exits.
 * The `.state.result` of each completed child is spread into the params
 * of the next.
 */
function pipe<Params, Result>(
  fns: ProcessFn<unknown, unknown, Message, Message>[],
): ProcessFn<
  Params,
  PipeState<Params, Result>,
  Message,
  Message | ExitMessage
> {
  return function* (
    ctx: ProcessCtx<
      Params,
      PipeState<Params, Result>,
      Message,
      Message | ExitMessage
    >,
    params: Params,
  ) {
    const state: PipeState<Params, Result> = {
      params: { ...params },
      result: null,
      running: false,
    };
    yield state;

    const queue = [...fns];
    let task: AsyncProcess<any, any, any, any>;

    function spawnNext(): void {
      const fn = queue.shift()!;
      task = ctx.forkSync(
        fn,
        `${ctx.pname} [${fn.name || "<anonymous>"}]`,
      )(state.params as Params);
    }

    function hasNext(): boolean {
      return queue.length > 0;
    }

    spawnNext();
    state.running = hasNext();

    yield* runDispatch<WithSender<Message | ExitMessage>>(
      ctx.pname,
      (maybe) => {
        const [msg, _sender] = maybe;

        if (msg.type === "STOP") {
          state.params = null;
          state.running = false;
          return;
        }

        if (msg.type === "EXIT" && (msg as ExitMessage).pid === task.id) {
          if (hasNext()) {
            state.params = {
              ...state.params!,
              ...task.state?.result,
            } as Params;
            spawnNext();
          } else {
            state.running = false;
            state.result = task.state?.result as Result;
          }
        }
      },
      () => !state.running,
      true,
    );
  };
}

export { pipe };
