import { runDispatch } from './core.js';

function* xfetch({ pname, toParent, send: toSelf }, { url }) {
  const state = { code: 'pending' };
  yield state;

  const controller = new AbortController();
  const signal = controller.signal;

  (async function do_request() {
    try {
      const res = await fetch(url.href, { signal });
      const text = await res.text();
      toSelf({ type: 'OK', text });
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

  yield* runDispatch(pname, (msg)=> {
    if (msg.type === 'STOP') {
      console.log('abort');
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
    if (msg.type === 'OK') {
      toParent(msg);
      state.code = 'ok';
    }
  }, ()=> state.code !== 'pending', true);
}

export { xfetch };
