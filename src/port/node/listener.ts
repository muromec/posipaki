// ── an HTTP server as a port listener ───────────────────────────────────────
//
// One request is one pair of ports: the request's body is what the far side sends, the response's body is what we
// send back, and the `Response` is built here because this is the only place that knows HTTP.  A handler above
// sees a pair and nothing about the protocol.
//
// The body is built before the handler runs, because a server must answer with a `Response` in the same turn it is
// asked: writes go into the response's stream, and closing the outbound port ends it.  The head — status and
// headers — rides the outbound port as one command, so the `Response` is built from what the handler chose.

import { HttpRefusal } from "../fetch.js";
import type { Channel } from "../channel.js";
import { held } from "../held.js";
import type { PortListener, PortPair } from "../reactor.js";

export interface HttpListenerOptions<Meta> {
  port?: number;
  hostname?: string;
  /** Admission before a body is made: what it returns is the pair's meta; throwing refuses the request. */
  identify?(request: Request): Meta | Promise<Meta>;
}

/** A port listener that is also an HTTP server: the port it bound, and the pairs it hands out. */
export interface HttpListener<Meta> extends PortListener<Uint8Array, Uint8Array, Meta> {
  readonly port: number;
}
/** What a response says before its body: the status and the headers a handler chose. */
export interface ResponseHead {
  readonly status: number;
  readonly headers?: HeadersInit;
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
 * A server whose requests arrive as pairs of ports.
 *
 * `identify` runs before a pair exists, so a refused request costs no stream and the caller reads a status with
 * the reason in it.  The request body is the inbound port; the response body is the outbound one.
 */
export function httpListener<Meta = unknown>(options: HttpListenerOptions<Meta> = {}): HttpListener<Meta> {
  const runtime = (globalThis as { Bun?: BunRuntime }).Bun;
  if (runtime === undefined) throw new Error("httpListener: this needs Bun's server");

  const waiting: Array<{ accept: (pair: PortPair<Uint8Array, Uint8Array, Meta, void>) => void; refuse: (error: Error) => void }> = [];
  const buffered: Array<PortPair<Uint8Array, Uint8Array, Meta, void>> = [];
  let closed = false;
  let server: BunServer | null = null;

  const take = (pair: PortPair<Uint8Array, Uint8Array, Meta, void>): void => {
    const next = waiting.shift();
    if (next === undefined) {
      buffered.push(pair);
      return;
    }
    next.accept(pair);
  };

  const bound = runtime.serve({
    port: options.port ?? 0,
    hostname: options.hostname,
    async fetch(request: Request): Promise<Response> {
      if (closed) return new Response("listener is closed", { status: 503 });
      let meta: Meta;
      try {
        meta = options.identify === undefined ? (undefined as Meta) : await options.identify(request);
      } catch (error) {
        // A refusal is an answer: a `HttpRefusal` says which status, anything else is the listener's own 401.
        const status = error instanceof HttpRefusal ? error.status : 401;
        return new Response(error instanceof Error ? error.message : String(error), { status });
      }
      const outbound = responsePort();
      take({ inbound: requestPort(request), outbound: outbound.channel, meta });
      // The handler says what it answers with before it writes — the head rides the outbound channel as one
      // command — so the `Response` is built once that is known rather than a 200 nobody chose.
      const head = await outbound.head;
      return new Response(outbound.body, {
        status: head.status,
        ...(head.headers === undefined ? {} : { headers: head.headers }),
      });
    },
  });
  server = bound;

  return {
    get port() {
      return server === null ? 0 : server.port;
    },
    accept(): Promise<PortPair<Uint8Array, Uint8Array, Meta, void>> {
      const next = buffered.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (closed) return Promise.reject(new Error("httpListener: closed"));
      return new Promise((accept, refuse) => {
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

/** The request's body as the inbound port: frames as they arrive, ended when the body is. */
function requestPort(request: Request): Channel<Uint8Array, void> {
  const readers = new Set<(frame: Uint8Array) => void>();
  const closers = new Set<(reason: void) => void>();
  let ended = false;

  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const closer of [...closers]) closer(undefined);
  };

  const inbound: Channel<Uint8Array, void> = {
    send: () => Promise.reject(new Error("a request body has no input; that side is the caller's")),
    onFrame(handler) {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
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
    close: async () => {
      await request.body?.cancel().catch(() => undefined);
      end();
    },
    info: { method: request.method, url: request.url },
    control: () => {},
  };

  const reader = request.body?.getReader();
  // Held before the first read: a body can arrive in the same turn the pair is handed out.
  const port = held(inbound);
  void (async () => {
    if (reader === undefined) {
      end();
      return;
    }
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        end();
        return;
      }
      for (const target of [...readers]) target(chunk.value);
    }
  })();
  return port;
}

/** The response's channel, and the body a `Response` is built from.  One stream, written by the channel. */
function responsePort(): {
  channel: Channel<Uint8Array, void>;
  body: ReadableStream<Uint8Array>;
  head: Promise<ResponseHead>;
} {
  const readers = new Set<(frame: Uint8Array) => void>();
  const closers = new Set<(reason: void) => void>();
  let ended = false;
  /** The head, once the handler has said it — or the first byte has, which is a 200. */
  let stated: ResponseHead | null = null;
  let settle: (head: ResponseHead) => void = () => {};
  const head = new Promise<ResponseHead>((resolve) => {
    settle = resolve;
  });
  const say = (what: ResponseHead): void => {
    if (stated !== null) return;
    stated = what;
    settle(what);
  };

  const end = (): void => {
    if (ended) return;
    // An answer that ends without saying anything is a 200 with no body, which is what the wire says too.
    say({ status: 200 });
    ended = true;
    for (const closer of [...closers]) closer(undefined);
  };

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

  const channel: Channel<Uint8Array, void> = {
    async send(frame) {
      if (ended) throw new Error("this response is over");
      for (const reader of [...readers]) reader(frame);
      say({ status: 200 });
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
    info: {},
    control(command) {
      // The head is a command on the same channel: a handler says what it answers with before it writes, and
      // the listener builds the `Response` from it.
      const head = command.head;
      if (typeof head === "object" && head !== null) {
        const status = (head as { status?: unknown }).status;
        const headers = (head as { headers?: unknown }).headers;
        say({
          status: typeof status === "number" ? status : 200,
          ...(typeof headers === "object" && headers !== null ? { headers: headers as HeadersInit } : {}),
        });
      }
    },
  };

  return { channel, body, head };
}
