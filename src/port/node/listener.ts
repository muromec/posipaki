// ── an HTTP server as a port listener ───────────────────────────────────────
//
// One request is one pair of ports: the request's body is what the far side sends, the response's body is what we
// send back.  A handler above sees a pair and nothing about the protocol; this is the only place that knows HTTP.
//
// The runtime is `node:http`, which is the whole of what a listener needs: a request is an async iterable of
// chunks, a response takes a head and then a body, and an upgrade arrives on the same server.  Nothing here asks
// what runs it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Channel } from "../channel.js";
import { HttpRefusal } from "../fetch.js";
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
  /** The server itself, for what only a consumer of it can do — a WebSocket upgrade, a second route. */
  readonly server: Server;
}

/** What a response says before its body: the status and the headers a handler chose. */
export interface ResponseHead {
  readonly status: number;
  readonly headers?: HeadersInit;
}

/**
 * A server whose requests arrive as pairs of ports.
 *
 * `identify` runs before a pair exists, so a refused request costs no stream and the caller reads a status with
 * the reason in it.  The request body is the inbound port; the response body is the outbound one, and the head
 * is one command on it.
 */
export function httpListener<Meta = unknown>(options: HttpListenerOptions<Meta> = {}): HttpListener<Meta> {
  const waiting: Array<{
    accept: (pair: PortPair<Uint8Array, Uint8Array, Meta, void>) => void;
    refuse: (error: Error) => void;
  }> = [];
  const buffered: Array<PortPair<Uint8Array, Uint8Array, Meta, void>> = [];
  let closed = false;

  const take = (pair: PortPair<Uint8Array, Uint8Array, Meta, void>): void => {
    const next = waiting.shift();
    if (next === undefined) {
      buffered.push(pair);
      return;
    }
    next.accept(pair);
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (closed) {
        response.writeHead(503).end("the listener is closed");
        return;
      }
      let meta: Meta;
      try {
        meta = options.identify === undefined ? (undefined as Meta) : await options.identify(asRequest(request));
      } catch (error) {
        // A refusal is an answer: a `HttpRefusal` says which status, anything else is the listener's own 401.
        const status = error instanceof HttpRefusal ? error.status : 401;
        response.writeHead(status).end(error instanceof Error ? error.message : String(error));
        return;
      }
      const outbound = responsePort(response);
      take({ inbound: requestPort(request), outbound, meta });
    })();
  });
  server.listen(options.port ?? 0, options.hostname);

  return {
    get port() {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : 0;
    },
    get server() {
      return server;
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
      server.closeAllConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/** The request as `identify` sees it: method, url and headers, and no body — the body is the inbound port. */
function asRequest(request: IncomingMessage): Request {
  const host = request.headers.host ?? "localhost";
  const method = request.method ?? "GET";
  return new Request(`http://${host}${request.url ?? "/"}`, {
    method,
    headers: Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value] as [string, string]],
    ),
  });
}

/** The request's body as the inbound port: frames as they arrive, ended when the body is. */
function requestPort(request: IncomingMessage): Channel<Uint8Array, void> {
  const readers = new Set<(frame: Uint8Array) => void>();
  const closers = new Set<(reason: void) => void>();
  let ended = false;

  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const closer of closers) closer(undefined);
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
      end();
      request.destroy();
    },
    info: { method: request.method ?? "GET", url: request.url ?? "/" },
    control: () => {},
  };

  // Held before the first read: a body can arrive in the same turn the pair is handed out.
  const port = held(inbound);
  request.on("data", (chunk: Buffer) => {
    if (ended) return;
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (const target of readers) target(bytes);
  });
  request.on("end", end);
  request.on("close", end);
  request.on("error", end);
  return port;
}

/**
 * The response's channel: the head is one command, the body is what `send` writes, and `close` ends it.
 *
 * `node:http` is told the head separately from the body, which is why a handler states it before the first byte,
 * and why a handler that writes without stating one gets the 200 the wire would have given anyway.
 */
function responsePort(response: ServerResponse): Channel<Uint8Array, void> {
  const readers = new Set<(reason: void) => void>();
  let stated = false;
  let ended = false;

  const state = (head: ResponseHead): void => {
    if (stated) return;
    stated = true;
    response.writeHead(head.status, head.headers as Record<string, string> | undefined);
  };

  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const reader of readers) reader(undefined);
  };
  // The client leaving is an ending of this channel too: a handler writing into it learns at once.
  response.on("close", end);

  return {
    async send(frame) {
      if (ended) throw new Error("this response is over");
      if (!stated) state({ status: 200 });
      await new Promise<void>((done) => {
        response.write(frame, () => done());
      });
    },
    onFrame() {
      return () => {};
    },
    onClose(handler) {
      if (ended) {
        handler(undefined);
        return () => {};
      }
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    onError() {
      return () => {};
    },
    async close() {
      if (ended) return;
      if (!stated) state({ status: 200 });
      ended = true;
      await new Promise<void>((done) => {
        response.end(() => done());
      });
    },
    info: {},
    control(command) {
      const head = command.head;
      if (typeof head !== "object" || head === null) return;
      const status = (head as { status?: unknown }).status;
      const headers = (head as { headers?: unknown }).headers;
      state({
        status: typeof status === "number" ? status : 200,
        ...(typeof headers === "object" && headers !== null ? { headers: headers as HeadersInit } : {}),
      });
    },
  };
}
