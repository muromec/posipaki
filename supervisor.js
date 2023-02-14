import { runDispatch } from './core.js';

function* supervise({pname, toParent, fork}, wrap = a=> a, debugLevel) {
  const state = wrap({ processes: [], phase: 'wait' });
  yield state;

  const hasExited = () => state.phase === 'stopping';

  yield* runDispatch(pname, (msg)=> {
    if (msg.type === 'RUN') {
      fork(msg.fn, msg.pname)(...msg.args);
      state.phase = 'running';
    }
    if (msg.type === 'ERROR' || msg.type === 'STOP') {
      state.phase = 'stopping';
    }
    if (msg.type === 'EXIT') {
      state.processes = state.processes.filter(
        iter=> iter.id !== msg.pid
      );
    }
    if (msg.type === 'OK') {
      toParent(msg);
    }
  }, hasExited, debugLevel);
}

function attach(supervisor, fn, pname) {
  return (...args) => {
    supervisor.send({ type: 'RUN', fn, args, pname});
  }
}
export { attach, supervise };
