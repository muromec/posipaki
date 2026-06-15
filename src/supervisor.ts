import { runDispatch } from "./util.js";
import type { Process, ProcessFn, ProcessCtx } from "./process.js";
import type { WithSender } from "./types.js";
import type { ExitMessage } from "./util.js";

// ---- messages ---------------------------------------------------------------

type SupMsg = ExitMessage | RunMsg | StopMsg | ErrorMsg | OkMsg;

interface RunMsg {
  type: "RUN";
  fn: ProcessFn<any, any, any, any>;
  args: any[];
  pname: string;
}

interface StopMsg {
  type: "STOP";
}

interface ErrorMsg {
  type: "ERROR";
}

interface OkMsg {
  type: "OK";
  [key: string]: unknown;
}

// ---- state ------------------------------------------------------------------

export interface SupervisorState {
  processes: Process<any, any, any, any>[];
  phase: "wait" | "running" | "stopping";
}

// ---- supervise --------------------------------------------------------------

/**
 * A supervisor process. Call `attach` to send it `RUN` messages —
 * it will fork the given function as a child. The supervisor exits
 * when it enters `'stopping'` phase (triggered by `ERROR` or `STOP`).
 *
 * @param wrap  optional transformation applied to the state before
 *              each yield (e.g. `reactive` from Vue)
 */
function* supervise(
  { pname, toParent, fork }: ProcessCtx<null, SupervisorState, SupMsg, SupMsg>,
  wrap: (s: SupervisorState) => SupervisorState = (a) => a,
  debugLevel = false,
): Generator<SupervisorState | null, void, WithSender<SupMsg>> {
  const state = wrap({ processes: [], phase: "wait" });
  yield state;

  yield* runDispatch<WithSender<SupMsg>>(
    pname,
    (maybe) => {
      const [msg, _sender] = maybe;
      switch (msg.type) {
        case "RUN":
          (fork as (...a: any[]) => any)(msg.fn, msg.pname)(...msg.args);
          state.phase = "running";
          break;
        case "ERROR":
        case "STOP":
          state.phase = "stopping";
          break;
        case "EXIT":
          state.processes = state.processes.filter((p) => p.id !== msg.pid);
          break;
        case "OK":
          toParent(msg);
          break;
      }
    },
    () => state.phase === "stopping",
    debugLevel,
  );
}

// ---- attach -----------------------------------------------------------------

/**
 * Bind a process function to a supervisor. The returned function,
 * when called, sends a `RUN` message so the supervisor forks the child.
 */
function attach<Args extends any[]>(
  supervisor: Process<any, any, SupMsg, SupMsg>,
  fn: ProcessFn<Args, any, any, any>,
  pname: string,
): (...args: Args) => void {
  return (...args) => {
    supervisor.send({ type: "RUN", fn, args, pname } as SupMsg);
  };
}

export { attach, supervise };
