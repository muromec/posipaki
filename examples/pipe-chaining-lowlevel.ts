import { spawnAsync, runDispatch } from "../src/index";
import { pipe } from "../src/pipe";

const timer = setTimeout(() => null, 1000 * 30);

function* f1({ pname, sendSelf }, { number }: { number: number }) {
  const state: { done: boolean; result: { number: number } | null } = {
    done: false,
    result: null,
  };
  yield state;
  console.log("run f1", number);
  const t = setTimeout(() => sendSelf({ type: "POKE" }), 100 * number);
  yield* runDispatch(
    pname,
    ([msg, _sender]) => {
      state.done = true;
      state.result = { number: number * 2 };
    },
    () => state.done,
    true,
  );
  clearTimeout(t);
  console.log("gone");
}

const f2 = f1;
const f3 = f1;

async function* main({ pname, fork }) {
  const state = { done: false };
  yield state;
  const worker = fork(pipe([f1, f2, f3]), "w")({ number: 1 });

  yield* runDispatch(
    pname,
    ([msg, _sender]) => {
      if (msg.type === "EXIT" || msg.type === "STOP") {
        state.done = true;
      }
    },
    () => state.done,
    true,
  );
  console.log("worker result", worker.state.result);
}

const m = spawnAsync(main, "main")(null);
setTimeout(() => m.send({ type: "STOP" } as any), 300);
await m.wait();
clearTimeout(timer);
