import { spawn, runDispatch } from './core.js';
import { supervise, attach } from './supervisor.js';
import { xfetch } from './xfetch.js';

import { reactive, computed, watch } from 'vue'

function* main({ pname, fork }) {
  const state = reactive({ s: null, r: null });
  yield state;

  const s = fork(supervise, 'super')(reactive);
  const urls = [
    new URL('https://api.myip.com'),
    new URL('https://x.myip.com'),
  ];
  for(let url of urls) {
    attach(s, xfetch, `xfetch ${url.href}`)({ url });
  }

  state.s = s;

  yield* runDispatch(pname, (msg)=> {
    if (msg.type === 'ABORT') {
      s.send({ type: 'ABORT'});
    }
    if (msg.type === 'EXIT') {
      state.s = null;
    }
    if (msg.type === 'OK') {
      state.r = msg.text
    }
  }, () => !state.s);
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
watch(m.state, () => {
  console.log('m', m.state.r);
});
//m.send({ type: 'ABORT', p: null});

await m.wait();
