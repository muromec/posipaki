// ── an HTTP request as a port ───────────────────────────────────────────────
//
// The response body is the channel's frames, `close()` aborts the request, and the ending is what the response
// said about itself.  A request that never got a response is a rejection, the way a spawner that cannot connect
// is: a non-2xx, a refused connection, a promise that never settles.

import type { Channel } from "./channel.js";
import { held } from "./held.js";

/** What a response said when its body was over. */
export interface HttpEnd {
  /** The status the far end answered with.  The frames that came before it are its body. */
  readonly status: number;
}

export interface FetchPortOptions {
  /** Passed to `fetch`: method, headers, body.  The request's own signal is not read; `close()` aborts. */
  init?: RequestInit;
  /** How long to wait for the response head.  No bound by default: a stream may be long. */
  connectMs?: number;
}

/**
 * A URL as a channel of the body it answers with.
 *
 * Frames are the chunks of the body as they arrive, so a caller reads a stream rather than waiting for a whole
 * response.  `close()` aborts the request, and the far side hears it.
 */
export async function fetchPort(url: string, options: FetchPortOptions = {}): Promise<Channel<Uint8Array, HttpEnd>> {
  const controller = new AbortController();
  const response = await answered(url, { ...options.init, signal: controller.signal }, options.connectMs);

  const readers = new Set<(frame: Uint8Array) => void>();
  const closers = new Set<(reason: HttpEnd) => void>();
  const failers = new Set<(error: unknown) => void>();
  const ending: HttpEnd = { status: response.status };
  let ended = false;

  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const closer of [...closers]) closer(ending);
  };

  const frames: Channel<Uint8Array, HttpEnd> = {
    send: () => Promise.reject(new Error("a response body has no input; send on the request instead")),
    onFrame(handler) {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    onClose(handler) {
      if (ended) {
        handler(ending);
        return () => {};
      }
      closers.add(handler);
      return () => {
        closers.delete(handler);
      };
    },
    onError(handler) {
      failers.add(handler);
      return () => {
        failers.delete(handler);
      };
    },
    async close() {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
    },
    info: { url },
    control: () => {},
  };

  const reader = response.body?.getReader();
  // Wrapped before the first read: a body can deliver a chunk in the same turn the port is handed over.
  const port = held(frames);

  const pump = async (): Promise<void> => {
    if (reader === undefined) {
      end();
      return;
    }
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          end();
          return;
        }
        for (const target of [...readers]) target(chunk.value);
      }
    } catch (error) {
      for (const failer of [...failers]) failer(error);
      end();
    }
  };
  void pump();

  return port;
}

/** The response head, or a rejection that says why there is none. */
async function answered(url: string, init: RequestInit, connectMs: number | undefined): Promise<Response> {
  const attempt = fetch(url, init).catch((error: unknown) => Promise.reject(named(url, error)));
  const response =
    connectMs === undefined
      ? await attempt
      : await Promise.race([
          attempt,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`fetchPort: ${url} answered nothing within ${connectMs}ms`)), connectMs),
          ),
        ]);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`fetchPort: ${url} answered ${response.status}${body === "" ? "" : `: ${body.slice(0, 200)}`}`);
  }
  return response;
}

function named(url: string, error: unknown): Error {
  return new Error(`fetchPort: ${url}: ${error instanceof Error ? error.message : String(error)}`);
}
