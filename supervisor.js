import { runDispatch } from './core.js';

function* supervise({pname, toParent, fork}, wrap = a=> a) {
  const state = wrap({ processes: [], phase: 'wait' });
  yield state;

  const hasExited = () => 
    state.phase === 'running' && state.processes.length === 0;

  yield* runDispatch(pname, (msg)=> {
    if (msg.type === 'RUN') {
      const newProcess = fork(msg.fn, msg.pname)(...msg.args);
      state.processes.push(newProcess);
      state.phase = 'running';
    }
    if (msg.type === 'ERROR' || msg.type === 'ABORT') {
      state.processes.forEach(p=> p.send({ type: 'ABORT'}));
    }
    if (msg.type === 'EXIT') {
      state.processes = state.processes.filter(
        iter=> iter.id !== msg.pid
      );
    }
    if (msg.type === 'OK') {
      toParent(msg);
    }
  }, hasExited);
}

function attach(supervisor, fn, pname) {
  return (...args) => {
    supervisor.send({ type: 'RUN', fn, args, pname});
  }
}
export { attach, supervise };
