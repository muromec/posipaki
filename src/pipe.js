import { runDispatch } from './util.js';

function pipe(fns) {
  return function* ({ pname, fork }, params) {
    const state = { params: { ...params }, result: null, running: false};
    yield state;

    const toRun = [...fns];
    function isDone() {
      return !state.running;
    }

    let task;
    function spawnNext(params) {
      const currentFn = toRun.shift();
      const name = pname + ` [${currentFn.name}]`;
      task = fork(currentFn, name)(state.params);
    }

    function hasNext() {
      return toRun.length > 0;
    }

    spawnNext();

    state.running = hasNext();
    yield* runDispatch(pname, msg => {
      if (msg.type === 'EXIT' && msg.pid === task.id) {
        if (hasNext()) {
          state.params = { ...state.params, ...task.state.result };
          spawnNext();
        } else {
          console.log('last one is gone');
          state.running = false;
          state.result = task.state.result;
        }
      }
      if (msg.type === 'STOP') {
        state.params = null;
        state.running = false;
      }
    }, isDone, true);
  };
}


export { pipe };
