import { spawn, runDispatch } from './core.js';
import { supervise, attach } from './supervisor.js';
import { xfetch } from './xfetch.js';

import { computed, watch } from 'vue'

function* main({ pname, fork }) {
  const s = fork(supervise, 'super')();
  const urls = [
    new URL('https://api.myip.com'),
    new URL('https://x.myip.com'),
  ];
  for(let url of urls) {
    attach(s, xfetch, `xfetch ${url.href}`)({ url });
  }

  yield* runDispatch(pname, (state, msg)=> {
    if (msg.type === 'INIT') {
      state.s = s;
    }
    if (msg.type === 'ABORT') {
      s.send({ type: 'ABORT'});
    }
    if (msg.type === 'EXIT') {
      state.s = null;
    }
    if (msg.type === 'OK') {
      console.log('data', msg.text);
      return 'STOPPED';
    }
  });
}

const m = spawn(main, 'main')();
const states = computed(() => {
  if (!m.state.s) {
    return null;
  }
  return m.state.s.state.processes.map(p => p.state);
});
watch(states, (value)=> {
  console.log('s', value);
}, { immediate: true });
//m.send({ type: 'ABORT', p: null});

await m.wait();
