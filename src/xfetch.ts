import { ExitMessage, runDispatch } from './util.js';
import type Process from './process';
import type { ProcessCtx, Message } from './process';

function isJsonHelper(res : Response) {
  const ct = res.headers.get('content-type');
  return ct === 'application/json';
}

export type FetchState<T> = {
  code: 'pending' | 'loading' | 'aborted' | 'failed' | 'ok',
  data: T | null,
  text: string | null,
};
type FetchArgsGet = {
  url: URL,
  method?: 'GET',
  body?: undefined,
};
type FetchArgsSend<T> = {
  url: URL,
  method?: 'POST' | 'PUT' | 'PATCH',
  body: T,
};
export type FetchArgs<T> = FetchArgsGet | FetchArgsSend<T>;

export type FetchMessage<T> = {
  type: 'OK',
  data?: T | null,
  text?: string | null,
}
| { type: 'ERROR' | 'LOADING' | 'ABORTED' | 'STOP' }
| ExitMessage;

type FetchGenerator<T, M> = Generator<FetchState<T> | null, void, M>;

export type FetchProcess<D> = Process<FetchArgs<D>, FetchState<D>, FetchMessage<D>, FetchMessage<D>>;


function* xfetch<Type>({ pname, toParent, send } : ProcessCtx<FetchMessage<Type>, FetchMessage<Type>>, { method='GET', url, body } : FetchArgs<Type>) : FetchGenerator<Type, FetchMessage<Type>> {
  const state: FetchState<Type> = { code: 'pending', data: null, text: null };
  yield state;

  const controller = new AbortController();
  const signal = controller.signal;

  const toSelf = send;

  (async function do_request() {
    try {
      toSelf({ type: 'LOADING'});
      const serializedBody = method === 'GET' ? undefined : JSON.stringify(body);
      const headers = new Headers({});
      if (serializedBody) {
        headers.set('content-type', 'application/json');
      };
      const res: Response = await fetch(url.href, { method, signal, body: serializedBody, headers });
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
        toSelf({ type: 'ABORTED' });
      } else {
        //console.log('e', e);
        toSelf({ type: 'ERROR' });
      }
    }
  })();

  const isDone = ()=> !(state.code === 'pending' || state.code === 'loading')

  yield* runDispatch<FetchMessage<Type>>(pname, (msg : FetchMessage<Type>)=> {
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
      state.data = msg.data || null;
      state.text = msg.text || null;
    }
  }, isDone, true);
}

export { xfetch };
