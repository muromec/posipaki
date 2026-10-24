import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "./index";
import { xfetch } from "./xfetch";
import { makeWaiter } from "./util";
import type { FetchArgs, FetchMessage } from "./xfetch";
import { nextState, nextMessage } from "./testing/tick-utils.js";

// bun shim
vi.stubGlobal =
  vi.stubGlobal ||
  ((name, value) => {
    (globalThis as Record<string | symbol, unknown>)[name] = value;
  });
vi.mocked = vi.mocked || ((v) => v);

// ---- helpers ----------------------------------------------------------------

/** A minimal Response-like object for mocking fetch. */
function mockResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return {
    ok: true,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

let mockedFetch = vi.mocked(fetch);

function withHangResponse(response: Response) {
  const waiter = makeWaiter<Response>();
  mockedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
    options?.signal?.addEventListener("abort", () => {
      waiter.reject(new DOMException("Aborted", "AbortError"));
    });
    return waiter.promise;
  });
  return {
    ...waiter,
    resume: () => waiter.resolve(response),
  };
}

function withResponse(response: Response) {
  mockedFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
  return mockedFetch;
}

function withError(err: Error) {
  mockedFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(err);
  return mockedFetch;
}

// ---- tests ------------------------------------------------------------------

describe("xfetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("hands the caller's init to fetch and says nothing of its own", async () => {
    withResponse(mockResponse("{}", { headers: { "content-type": "application/json" } }));

    const proc = spawn(
      xfetch,
      "xfetch-init",
    )({
      url: new URL("https://example.com/api/items"),
      init: {
        method: "POST",
        body: '{"name":"test"}',
        headers: { Authorization: "Bearer t" },
        timeout: 3_600_000,
      },
    } as FetchArgs);

    await proc.ready();

    // Everything the caller said, exactly as said: the body is not re-serialized, no header is added,
    // and the deadline it chose is the deadline fetch gets.
    expect(mockedFetch).toHaveBeenCalledWith(
      "https://example.com/api/items",
      expect.objectContaining({
        method: "POST",
        body: '{"name":"test"}',
        headers: new Headers({ Authorization: "Bearer t" }),
        timeout: 3_600_000,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("adds no content-type of its own", async () => {
    withResponse(mockResponse("ok"));

    const proc = spawn(
      xfetch,
      "xfetch-no-content-type",
    )({
      url: new URL("https://example.com/api/items"),
      init: { method: "POST", body: "a=1&b=2" },
    } as FetchArgs);
    await proc.ready();

    const sent = mockedFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(sent.headers).get("content-type")).toBeNull();
  });

  it("returns the answer as text, whatever the content-type says", async () => {
    withResponse(
      mockResponse({ items: [1, 2, 3] }, { headers: { "content-type": "application/json" } }),
    );

    const proc = spawn(
      xfetch,
      "xfetch-text",
    )({ url: new URL("https://example.com/api/items") } as FetchArgs);
    await proc.ready();

    expect(await nextMessage(proc)).toMatchObject({
      type: "OK",
      text: '{"items":[1,2,3]}',
      status: 200,
    });
    // No parse, so no second copy of the answer in the state either.
    expect(proc.state).toMatchObject({ code: "ok", status: 200, text: '{"items":[1,2,3]}' });
  });

  it("exposes the status and the response headers", async () => {
    withResponse(
      mockResponse("created", {
        status: 201,
        headers: { "x-ratelimit-remaining": "42", "content-type": "text/plain" },
      }),
    );

    const proc = spawn(
      xfetch,
      "xfetch-headers",
    )({ url: new URL("https://example.com/api/created") } as FetchArgs);
    await proc.ready();

    expect(await nextMessage(proc)).toMatchObject({
      type: "OK",
      status: 201,
      text: "created",
      responseHeaders: expect.objectContaining({ "x-ratelimit-remaining": "42" }),
    });
  });

  it("carries the cause of a failure in words", async () => {
    withError(new TypeError("socket hang up"));

    const proc = spawn(
      xfetch,
      "xfetch-error",
    )({ url: new URL("https://example.com/api/fail") } as FetchArgs);
    await proc.ready();

    expect(await nextMessage(proc)).toMatchObject({
      type: "ERROR",
      reason: "socket hang up",
    });
    expect(proc.state).toMatchObject({ code: "failed" });
    await proc.wait();
  });

  it("names a timeout for what it is", async () => {
    withError(new Error("The operation timed out."));

    const proc = spawn(
      xfetch,
      "xfetch-timeout",
    )({ url: new URL("https://example.com/api/slow") } as FetchArgs);
    await proc.ready();

    expect(await nextMessage(proc)).toMatchObject({
      type: "ERROR",
      reason: "The operation timed out.",
    });
    await proc.wait();
  });

  it("treats an abort as an abort, not a failure", async () => {
    withError(new DOMException("Aborted", "AbortError"));

    const proc = spawn(
      xfetch,
      "xfetch-aborted",
    )({ url: new URL("https://example.com/api/slow") } as FetchArgs);
    await proc.ready();

    expect(await nextMessage(proc)).toMatchObject({ type: "ABORTED" });
    expect(proc.state).toMatchObject({ code: "aborted" });
    await proc.wait();
  });

  it("aborts the request when STOP is received", async () => {
    withHangResponse(mockResponse("done"));

    const proc = spawn(
      xfetch,
      "xfetch-stop",
    )({ url: new URL("https://example.com/api/slow") } as FetchArgs);

    expect(await nextState(proc)).toMatchObject({ code: "loading" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    proc.send({ type: "STOP" } as unknown as FetchMessage);

    expect(await nextMessage(proc)).toMatchObject({ type: "ABORTED" });
    expect(await nextState(proc)).toMatchObject({ code: "aborted" });
    await proc.wait();
  });
});
