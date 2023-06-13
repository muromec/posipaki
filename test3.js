import { spawn, runDispatch } from './index.js';
import { pipe } from './pipe.js';

const timer = setTimeout(()=> null, 1000 * 30);


function* f1({ pname, send }, { number }) {
  const state = { done: false, result: null };
  yield state;
  console.log('run f1', number);
  const timer = setTimeout(()=> send({ type: 'POKE'}), 100 * number);
  yield* runDispatch(pname, msg => {
      state.done = true;
      state.result = { number: number * 2 };
  }, ()=> state.done, true);
  clearTimeout(timer);
  console.log('gone');
}

const f2 = f1;
const f3 = f1;

function* main({ pname, fork }) {
  const state = { done: false };
  yield state;
  const worker = fork(pipe([f1, f2, f3]), 'w')({ number: 1 });

  yield* runDispatch(pname, (msg) => {
    if (msg.type === 'EXIT' || msg.type === 'STOP') {
      state.done = true;
    }
  }, ()=> state.done, true);
  console.log('worker result', worker.state.result);
}

const m = spawn(main, 'main')();
setTimeout(()=> m.send({ type: 'STOP' }), 300);
await m.wait();
clearTimeout(timer);
