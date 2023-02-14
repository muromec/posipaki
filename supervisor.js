import { runDispatch } from './core.js';

function* supervise({pname, toParent, fork}) {
  yield* runDispatch(pname, (state, msg)=> {
    if (msg.type === 'INIT') {
      state.processes = [];
    };
    if (msg.type === 'RUN') {
      const newProcess = fork(msg.fn, msg.pname)(...msg.args);
      state.processes.push(newProcess);
    }
    if (msg.type === 'ERROR' || msg.type === 'ABORT') {
      state.processes.forEach(p=> p.send({ type: 'ABORT'}));
    }
    if (msg.type === 'EXIT') {
      state.processes = state.processes.filter(
        iter=> iter.id !== msg.pid
      );
      if (state.processes.length === 0) {
        return 'STOPPED';
      }
    }
    if (msg.type === 'OK') {
      toParent(msg);
    }
  });
}

function attach(supervisor, fn, pname) {
  return (...args) => {
    supervisor.send({ type: 'RUN', fn, args, pname});
  }
}
export { attach, supervise };
