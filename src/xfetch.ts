import { runDispatch } from "./util.js";
import type { ExitMessage, WithSender, ProcessCtx } from "./types.js";
import type { Process } from "./process.js";

// ---- types ------------------------------------------------------------------

/**
 * A fetch init, plus the deadline that is not in the standard.
 *
 * `timeout` is Bun's socket idle deadline: the request fails if the connection stays idle that long.
 * Bun's default is five minutes, which a slow generation outlives; this is the only place a caller can
 * say otherwise. On a runtime that does not know the field, `fetch` ignores it.
 */
export type FetchInit = RequestInit & {
  timeout?: number | boolean;
};

/** Arguments for a fetch process: a URL, and the init the caller wants sent with it. */
export type FetchArgs = {
  url: URL;
  init?: FetchInit;
};

/** State of an in-flight or completed fetch. */
export type FetchState = {
  code: "pending" | "loading" | "aborted" | "failed" | "ok";
  /** The answer's body as text, whatever its content-type said. */
  text: string | null;
  status: number;
  responseHeaders: Record<string, string>;
};

/** Messages emitted by a fetch process during its lifecycle. */
export type FetchMessage =
  | {
      type: "OK";
      text: string;
      status: number;
      responseHeaders: Record<string, string>;
    }
  | {
      type: "ERROR";
      /** What went wrong, in the words of whatever threw: `socket hang up`, `The operation timed out.` */
      reason: string;
    }
  | { type: "LOADING" | "ABORTED" | "STOP" }
  | ExitMessage;

/** A process that performs an HTTP fetch. */
export type FetchProcess = Process<FetchArgs, FetchState, FetchMessage, FetchMessage>;

// ---- helpers ----------------------------------------------------------------

/** Convert a Headers object to a plain Record. */
function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** The cause of a failure, in words.  A bare word is what made a 300 s deadline look like a network fault. */
function reasonOf(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

// ---- xfetch -----------------------------------------------------------------

/**
 * Fetch, as a process.
 *
 * A pipe and nothing more: the init is handed to `fetch` untouched, the answer's body comes back as
 * text with its status and headers, and a failure carries its cause.  It parses nothing, shapes no
 * request, and imposes no deadline of its own.
 *
 * It is a process because a request may run for minutes: the caller's loop must stay able to hear
 * HEARTBEAT and STOP while it waits, and `STOP` aborts the request through the signal below.
 */
function* xfetch(
  {
    pname,
    toParent,
    sendSelf,
  }: ProcessCtx<FetchArgs, FetchState, FetchMessage, FetchMessage>,
  { url, init }: FetchArgs,
): Generator<FetchState | null, void, WithSender<FetchMessage>> {
  const state: FetchState = {
    code: "pending",
    text: null,
    status: 0,
    responseHeaders: {},
  };
  yield state;

  const controller = new AbortController();
  const toSelf = sendSelf;

  (async function doRequest() {
    try {
      toSelf({ type: "LOADING" });
      // Our signal wins: the caller's STOP has to be able to abort whatever was sent.
      const requestInit: FetchInit = { ...init, signal: controller.signal };
      const res: Response = await fetch(url.href, requestInit);
      const text = await res.text();
      toSelf({
        type: "OK",
        text,
        status: res.status,
        responseHeaders: headersToRecord(res.headers),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        toSelf({ type: "ABORTED" });
      } else {
        toSelf({ type: "ERROR", reason: reasonOf(e) });
      }
    }
  })();

  const isDone = (): boolean => !(state.code === "pending" || state.code === "loading");

  yield* runDispatch<WithSender<FetchMessage>>(
    pname,
    (maybe: WithSender<FetchMessage>) => {
      const [msg, _sender] = maybe;
      if (msg.type === "STOP") {
        controller.abort();
      }
      if (msg.type === "ABORTED") {
        toParent(msg);
        state.code = "aborted";
      }
      if (msg.type === "ERROR") {
        toParent(msg);
        state.code = "failed";
      }
      if (msg.type === "LOADING") {
        state.code = "loading";
      }
      if (msg.type === "OK") {
        toParent(msg);
        state.code = "ok";
        state.text = msg.text;
        state.status = msg.status;
        state.responseHeaders = msg.responseHeaders;
      }
    },
    isDone,
    false,
  );
}

export { xfetch };
