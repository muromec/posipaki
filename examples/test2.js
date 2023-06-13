import { spawn, runDispatch } from '../src/index.js';

const timer = setTimeout(()=> null, 1000 * 30);

function* fast({ pname }) {
  const state = true;
  yield state;
  yield* runDispatch(pname, msg => {
  }, ()=> state, true)
}

function* slow({ pname, send }) {
  const state = { done: false }
  yield state;

  const timer = setTimeout(() => {
    send({ type: 'FIRED'})
  }, 10 * 1000);

  yield* runDispatch(pname, msg => {
    state.done = true;
  }, ()=> state.done, true)

  clearTimeout(timer);
}

function* main({ pname, fork }) {
  const state = { done: false };
  yield state;
  const child = fork(fast, 'f1')();
  const timer = fork(slow, 'timer')();

  yield* runDispatch(pname, (msg) => {
    if (msg.type === 'EXIT' && msg.pid === child.id) {
      // state.done = true;
    }
    if (msg.type === 'EXIT' && msg.pid === timer.id) {
      state.done = true;
    }
  }, ()=> state.done, true);
}

const m = spawn(main, 'main')();
await m.wait();
clearTimeout(timer);
