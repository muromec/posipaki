import { runDispatch } from './index.js';

function isJsonHelper(res) {
  const ct = res.headers.get('content-type');
  return ct === 'application/json';
}

function* xfetch({ pname, toParent, send: toSelf }, { url }) {
  const state = { code: 'pending', data: null, text: null };
  yield state;

  const controller = new AbortController();
  const signal = controller.signal;

  (async function do_request() {
    try {
      toSelf({ type: 'LOADING'});
      const res = await fetch(url.href, { signal });
      if (isJsonHelper(res)) {
        const data = await res.json();
        toSelf({ type: 'OK', data });
      } else {
        const text = await res.text();
        toSelf({ type: 'OK', text });
      }
    } catch (e) {
      const isAborted = (e instanceof DOMException && e.name === 'AbortError');
      if (isAborted) {
        toSelf({ type: 'ABORTED', pname });
      } else {
        //console.log('e', e);
        toSelf({ type: 'ERROR', pname });
      }
    }
  })();

  const isDone = ()=> !(state.code === 'pending' || state.code === 'loading')

  yield* runDispatch(pname, (msg)=> {
    if (msg.type === 'STOP') {
      controller.abort();
    }
    if (msg.type === 'ABORTED') {
      toParent(msg);
      state.code = 'aborted';
    }
    if (msg.type === 'ERROR') {
      toParent(msg);
      state.code = 'failed';
    }
    if (msg.type === 'LOADING') {
      state.code = 'loading';
    }

    if (msg.type === 'OK') {
      toParent(msg);
      state.code = 'ok';
      state.data = msg.data;
      state.text = msg.text;
    }
  }, isDone, true);
}

export { xfetch };
