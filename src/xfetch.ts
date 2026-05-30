import { runDispatch } from "./util.js";
import type { ExitMessage, ProcessCtx } from "./types.js";
import type { Process } from "./process.js";

// ---- types ------------------------------------------------------------------

/** State of an in-flight or completed fetch. */
export type FetchState<T> = {
  code: "pending" | "loading" | "aborted" | "failed" | "ok";
  data: T | null;
  text: string | null;
};

/** Arguments for a fetch process. */
export type FetchArgs<T> =
  | { url: URL; method?: "GET"; body?: undefined }
  | { url: URL; method?: "POST" | "PUT" | "PATCH"; body: T };

/** Messages emitted by a fetch process during its lifecycle. */
export type FetchMessage<T> =
  | { type: "OK"; data?: T | null; text?: string | null }
  | { type: "ERROR" | "LOADING" | "ABORTED" | "STOP" }
  | ExitMessage;

/** A process that performs an HTTP fetch. */
export type FetchProcess<D> = Process<
  FetchArgs<D>,
  FetchState<D>,
  FetchMessage<D>,
  FetchMessage<D>
>;

// ---- helpers ----------------------------------------------------------------

function isJsonHelper(res: Response): boolean {
  const ct = res.headers.get("content-type");
  return ct === "application/json";
}

// ---- xfetch -----------------------------------------------------------------

/**
 * A fetch wrapper implemented as a process. Supports GET/POST/PUT/PATCH,
 * JSON detection, abort via AbortController, and yields a
 * {@link FetchState} with the current status.
 */
function* xfetch<Type>(
  { pname, toParent, send }: ProcessCtx<FetchMessage<Type>, FetchMessage<Type>>,
  { method = "GET", url, body }: FetchArgs<Type>,
): Generator<FetchState<Type> | null, void, FetchMessage<Type>> {
  const state: FetchState<Type> = { code: "pending", data: null, text: null };
  yield state;

  const controller = new AbortController();
  const signal = controller.signal;
  const toSelf = send;

  (async function doRequest() {
    try {
      toSelf({ type: "LOADING" });
      const serializedBody =
        method === "GET" ? undefined : JSON.stringify(body);
      const headers = new Headers({});
      if (serializedBody) {
        headers.set("content-type", "application/json");
      }
      const res: Response = await fetch(url.href, {
        method,
        signal,
        body: serializedBody,
        headers,
      });
      if (isJsonHelper(res)) {
        const data = await res.json();
        toSelf({ type: "OK", data });
      } else {
        const text = await res.text();
        toSelf({ type: "OK", text });
      }
    } catch (e) {
      const isAborted = e instanceof DOMException && e.name === "AbortError";
      if (isAborted) {
        toSelf({ type: "ABORTED" });
      } else {
        toSelf({ type: "ERROR" });
      }
    }
  })();

  const isDone = (): boolean =>
    !(state.code === "pending" || state.code === "loading");

  yield* runDispatch<FetchMessage<Type>>(
    pname,
    (msg: FetchMessage<Type>) => {
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
        state.data = msg.data || null;
        state.text = msg.text || null;
      }
    },
    isDone,
    true,
  );
}

export { xfetch };
