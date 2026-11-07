// ── an HTTP server whose answers are ports ──────────────────────────────────
//
// One connection is one request and one response channel.  The listener accepts a request and hands back the
// channel its body is written to: one frame and a close is a whole response, many frames is a stream, and no
// frame at all is an empty body.  Nothing above the listener sees a `Response`.
//
// The body is built before the handler runs, because a server must answer with a `Response` in the same turn it
// is asked: the channel writes into the response's stream, and `close()` ends it.

import type { Channel } from "../channel.js";

/** One request, and the channel its answer is written to. */
export interface HttpAccept<Meta> {
  readonly request: Request;
  /** Whatever the listener resolved about the caller: admission, a token's subject, a path. */
  readonly meta: Meta;
  /** Write the body here.  The first frame starts it arriving; `close()` ends the response. */
  readonly response: Channel<Uint8Array, void>;
}

export interface HttpListenerOptions<Meta> {
  port?: number;
  hostname?: string;
  /** Admission before a body is made: what it returns is the connection's meta; throwing refuses the request. */
  identify?(request: Request): Meta | Promise<Meta>;
  /** How long `accept()` waits for a request before giving up.  No bound by default. */
  timeoutMs?: number;
}

/** Where a request comes from.  One at a time, in arrival order. */
export interface HttpListener<Meta> {
  accept(): Promise<HttpAccept<Meta>>;
  /** The port it bound, once it has one. */
  readonly port: number;
  close(): Promise<void>;
}

/** The Bun server this wraps, as little of it as is used here. */
interface BunServer {
  readonly port: number;
  stop(force?: boolean): void | Promise<void>;
}

interface BunRuntime {
  serve(options: {
    port: number;
    hostname?: string;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServer;
}

/**
 * A server that answers with a port per request.
 *
 * `identify` runs before the body channel exists, so a refused request costs no stream and the caller reads a
 * status instead.  The handler writes frames; the listener owns the `Response`.
 */
export function httpListener<Meta = unknown>(options: HttpListenerOptions<Meta> = {}): HttpListener<Meta> {
  const runtime = (globalThis as { Bun?: BunRuntime }).Bun;
  if (runtime === undefined) throw new Error("httpListener: this needs Bun's server");

  const waiting: Array<{ accept: (value: HttpAccept<Meta>) => void; refuse: (error: Error) => void }> = [];
  const held: HttpAccept<Meta>[] = [];
  let closed = false;
  let server: BunServer | null = null;

  const take = (value: HttpAccept<Meta>): void => {
    const next = waiting.shift();
    if (next === undefined) {
      held.push(value);
      return;
    }
    next.accept(value);
  };

  const listener: BunServer = runtime.serve({
    port: options.port ?? 0,
    hostname: options.hostname,
    async fetch(request: Request): Promise<Response> {
      if (closed) return new Response("listener is closed", { status: 503 });
      let meta: Meta;
      try {
        meta = options.identify === undefined ? (undefined as Meta) : await options.identify(request);
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 401 });
      }
      const { response, body } = responsePort();
      take({ request, meta, response });
      return new Response(body);
    },
  });
  server = listener;

  return {
    get port() {
      return server === null ? 0 : server.port;
    },
    accept(): Promise<HttpAccept<Meta>> {
      const buffered = held.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (closed) return Promise.reject(new Error("httpListener: closed"));
      return new Promise<HttpAccept<Meta>>((accept, refuse) => {
        waiting.push({ accept, refuse });
      });
    },
    async close(): Promise<void> {
      closed = true;
      for (const next of waiting.splice(0)) next.refuse(new Error("httpListener: closed"));
      await server?.stop(true);
      server = null;
    },
  };
}

/** The response's channel, and the body a `Response` is built from.  One stream, written by the channel. */
function responsePort(): { response: Channel<Uint8Array, void>; body: ReadableStream<Uint8Array> } {
  const readers = new Set<(frame: Uint8Array) => void>();
  const closers = new Set<(reason: void) => void>();
  let ended = false;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      readers.add((frame) => controller.enqueue(frame));
      closers.add(() => {
        try {
          controller.close();
        } catch {
          // Already closed by the platform: nothing here has an opinion about it.
        }
      });
    },
    cancel() {
      // The caller stopped reading: the channel is over from this side too.
      end();
    },
  });

  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const closer of [...closers]) closer(undefined);
  };

  const response: Channel<Uint8Array, void> = {
    async send(frame) {
      if (ended) throw new Error("this response is over");
      for (const reader of [...readers]) reader(frame);
    },
    onFrame() {
      return () => {};
    },
    onClose(handler) {
      if (ended) {
        handler(undefined);
        return () => {};
      }
      closers.add(handler);
      return () => {
        closers.delete(handler);
      };
    },
    onError() {
      return () => {};
    },
    async close() {
      end();
    },
  };

  return { response, body };
}
