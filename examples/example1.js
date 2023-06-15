import { spawn, runDispatch } from '../src/index';
import { supervise, attach } from '../src/supervisor';
import { xfetch } from '../src/xfetch';

import { reactive, computed, watch } from 'vue'

function* main({ pname, fork }) {
  const state = reactive({ s: null, r: null });
  yield state;

  const s = fork(supervise, 'super')(reactive, true);
  const urls = [
    new URL('https://api.myip.com'),
    new URL('https://x.myip.com'),
  ];
  for(let url of urls) {
    attach(s, xfetch, `xfetch ${url.href}`)({ url });
  }

  state.s = s;

  yield* runDispatch(pname, (msg)=> {
    if (msg.type === 'STOP') {
      state.s = null;
    }
    if (msg.type === 'EXIT') {
      state.s = null;
    }
    if (msg.type === 'OK') {
      state.r = msg.text
    }
  }, () => !state.s, true);
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
//m.send({ type: 'STOP', p: null});

await m.wait();
