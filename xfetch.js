import { runDispatch } from './core.js';

function* xfetch({ pname, toParent, send: toSelf }, { url }) {
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
    toSelf({ type: 'DONE' });
  })();

  yield* runDispatch(pname, (state, msg)=> {
    if (msg.type === 'INIT') {
      state.code = 'pending';
    }
    if (msg.type === 'ABORT') {
      controller.abort();
    }
    if (msg.type === 'DONE') {
      return 'STOPPED';
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
  });
}

export { xfetch };
