import { spawnAsync, runDispatch } from "../src/index";

const timer = setTimeout(() => null, 1000 * 30);

async function* fast({ pname }) {
  const state = true;
  yield state;
  yield* runDispatch(pname, () => {}, () => state, true);
}

async function* slow({ pname, sendSelf }) {
  const state = { done: false };
  yield state;

  const t = setTimeout(() => sendSelf({ type: "FIRED" } as any), 10 * 1000);

  yield* runDispatch(
    pname,
    ([msg, _sender]) => {
      state.done = true;
    },
    () => state.done,
    true,
  );

  clearTimeout(t);
}

async function* main({ pname, fork }) {
  const state = { done: false };
  yield state;
  const child = fork(fast, "f1")(null);
  const timerProc = fork(slow, "timer2")(null);

  yield* runDispatch(
    pname,
    ([msg, sender]) => {
      if (msg.type === "EXIT" && sender.fromId === timerProc.id) {
        state.done = true;
      }
    },
    () => state.done,
    true,
  );
}

const m = spawnAsync(main, "main")(null);
await m.wait();
clearTimeout(timer);
