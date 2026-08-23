import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "./index";
import { xfetch } from "./xfetch";
import { makeWaiter } from "./util";
import type { FetchArgs, FetchState, FetchMessage } from "./xfetch";
import { nextState, nextMessage } from './testing/tick-utils.js';

// bun shim
vi.stubGlobal = vi.stubGlobal || (
  (name, value) => {
    (globalThis as Record<string | symbol, unknown>)[name] = value;
  }
);
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
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

let mockedFetch = vi.mocked(fetch);

function withHangResponse(response: Response) {
  const waiter = makeWaiter<Response>();
  mockedFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
    (url, options) => {
      options?.signal?.addEventListener("abort", () => {
        waiter.reject(new DOMException("Aborted", "AbortError"))
      });
      return waiter.promise;
    }
  );
  return {
    ...waiter,
    resume: ()=> waiter.resolve(response),
  };
}

function withResponse(response: Response) {
  mockedFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
  return mockedFetch;
}

function withError(err : Error) {
  mockedFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(err);
  return mockedFetch;
}

// ---- tests ------------------------------------------------------------------

describe("xfetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  // -- GET -------------------------------------------------------------------

  it("performs a GET and returns OK with data", async () => {
    const data = { items: [1, 2, 3] };
    withResponse(
      mockResponse(data, { headers: { "content-type": "application/json" } })
    );

    const proc = spawn(
      xfetch<typeof data>,
      "xfetch-get",
    )({
      url: new URL("https://example.com/api/items"),
      method: "GET",
    } as FetchArgs<typeof data>);

    await proc.ready();
    expect(proc.state).toMatchObject({ code: "pending", data: null });

    expect(mockedFetch).toHaveBeenCalledWith("https://example.com/api/items", expect.objectContaining({ method: 'GET' }));

    expect(await nextMessage(proc)).toMatchObject({
      type: "OK", data, status: 200,
    });
    expect(proc.state).toMatchObject({ code: "ok", data });
    expect(await nextMessage(proc)).toMatchObject({
      type: "EXIT",
    });
  });

  it("returns OK with text for non-JSON content-type", async () => {
    const text = "plain text response";
    withResponse(
      mockResponse(text, { headers: { "content-type": "text/plain" } }),
    );
    const proc = spawn(
      xfetch<string>,
      "xfetch-text",
    )({
      url: new URL("https://example.com/api/notes"),
      method: "GET",
    } as FetchArgs<string>);

    await proc.ready();

    // FIXME: protocol makes no sense
    expect(await nextMessage(proc)).toMatchObject({
      type: "OK", text: JSON.stringify(text), status: 200,
    });
    expect(proc.state).toMatchObject({
      code: "ok",
      text: JSON.stringify(text),
    });
  });

  // -- POST ------------------------------------------------------------------

  it("performs a POST with JSON body and Content-Type header", async () => {
    const body = { name: "test" };
    const responseData = { id: 1, name: "test" };
    withResponse(
      mockResponse(responseData, {
        headers: { "content-type": "application/json" },
      })
    );

    const proc = spawn(
      xfetch<typeof responseData>,
      "xfetch-post",
    )({
      url: new URL("https://example.com/api/items"),
      method: "POST",
      body,
    } as FetchArgs<typeof responseData>);

    await proc.ready();

    expect(mockedFetch).toHaveBeenCalledWith('https://example.com/api/items', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(body),
      headers: new Headers({
        "content-type": "application/json",
      }),
    }));
    
    expect(await nextMessage(proc)).toMatchObject(
      { type: "OK", data: responseData },
    );
    expect(proc.state).toMatchObject({ code: "ok", data: responseData });
  });

  // -- status code & response headers ---------------------------------------

  it("exposes response status code and headers in OK message", async () => {
    const responseData = { ok: true };
    withResponse(
      mockResponse(responseData, {
        status: 201,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "42",
        },
      }),
    );

    const proc = spawn(
      xfetch<typeof responseData>,
      "xfetch-status-headers",
    )({
      url: new URL("https://example.com/api/created"),
      method: "POST",
      body: responseData,
    } as FetchArgs<typeof responseData>);

    await proc.ready();

    expect(await nextMessage(proc)).toMatchObject({
      type: "OK",
      data: responseData,
      status: 201,
      responseHeaders: expect.objectContaining({
        "x-ratelimit-remaining": "42",
      }),
    })
  });

  it("exposes status and responseHeaders in FetchState", async () => {
    const responseData = { done: true };
    withResponse(
      mockResponse(responseData, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "abc-123",
        },
      }),
    );

    const proc = spawn(
      xfetch<typeof responseData>,
      "xfetch-state-headers",
    )({
      url: new URL("https://example.com/api/item"),
      method: "GET",
    } as FetchArgs<typeof responseData>);

    await proc.ready();

    expect(await nextState(proc)).toMatchObject({
      code: "ok",
      status: 200,
      responseHeaders: expect.objectContaining({
        "x-request-id": "abc-123",
      }),
    });
  });

  it("exposes status and headers for non-JSON responses too", async () => {
    withResponse(
      mockResponse("Not Found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    );

    const proc = spawn(
      xfetch<string>,
      "xfetch-nonjson-headers",
    )({
      url: new URL("https://example.com/api/missing"),
      method: "GET",
    } as FetchArgs<string>);

    await proc.ready();

    expect(await nextMessage(proc)).toMatchObject({
      type: "OK",
      text: JSON.stringify("Not Found"),
      status: 404,
      responseHeaders: expect.any(Object),
    });
    expect(proc.state).toMatchObject({ code: "ok", status: 404 });
  });

  // -- custom headers --------------------------------------------------------

  it("passes custom headers through to fetch (POST)", async () => {
    const body = { name: "authed" };
    const responseData = { ok: true };
    withResponse(
      mockResponse(responseData, {
        headers: { "content-type": "application/json" },
      }),
    );

    const proc = spawn(
      xfetch<typeof body>,
      "xfetch-headers-post",
    )({
      url: new URL("https://example.com/api/protected"),
      method: "POST",
      body,
      headers: {
        Authorization: "Bearer secret-token",
        "User-Agent": "my-app/1.0",
      },
    } as FetchArgs<typeof body>);

    await proc.ready();

    expect(mockedFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: new Headers({
          "content-type": "application/json",
          Authorization: "Bearer secret-token",
          "User-Agent": "my-app/1.0",
        }),
      }),
    );
  });

  it("passes custom headers through to fetch (GET)", async () => {
    withResponse(
      mockResponse(null, {
        headers: { "content-type": "application/json" },
      }),
    );

    const proc = spawn(
      xfetch<null>,
      "xfetch-headers-get",
    )({
      url: new URL("https://example.com/api/items"),
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer gh-token",
      },
    } as FetchArgs<null>);

    await proc.ready();

    expect(mockedFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: new Headers({
          Accept: "application/vnd.github+json",
          Authorization: "Bearer gh-token",
        }),
      }),
    );
  });

  it("xfetch caller can override content-type", async () => {
    const body = { value: 42 };
    withResponse(
      mockResponse(
        { ok: true },
        {
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const proc = spawn(
      xfetch<typeof body>,
      "xfetch-ct-override",
    )({
      url: new URL("https://example.com/api/thing"),
      method: "POST",
      body,
      headers: {
        "content-type": "text/html", // caller override
      },
    } as FetchArgs<typeof body>);

    await proc.ready();

    expect(mockedFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: new Headers({
          "content-type": "text/html", // caller override
        }),
      }),
    );
  });

  // -- ERROR -----------------------------------------------------------------

  it("handles network errors and transitions to failed", async () => {
    withError(new Error("Network failure"));

    const proc = spawn(
      xfetch<null>,
      "xfetch-error",
    )({
      url: new URL("https://example.com/api/fail"),
      method: "GET",
    } as FetchArgs<null>);

    await proc.ready();

    expect(await nextMessage(proc)).toMatchObject({ type: "ERROR" });
    expect(proc.state).toMatchObject({ code: "failed" });
    await proc.wait();
  });

  it("handles AbortError and transitions to aborted", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    withError(abortError);

    const proc = spawn(
      xfetch<null>,
      "xfetch-abort",
    )({
      url: new URL("https://example.com/api/slow"),
      method: "GET",
    } as FetchArgs<null>);

    await proc.ready();

    expect(await nextMessage(proc)).toMatchObject({ type: "ABORTED" });
    expect(proc.state).toMatchObject({ code: "aborted" });
    await proc.wait();
  });

  // -- ABORT via STOP --------------------------------------------------------

  it("aborts the request when STOP is received", async () => {
    // Make fetch hang so we can send STOP before it settles
    const hang = withHangResponse(
      mockResponse(
        { done: true },
        { headers: { "content-type": "application/json" } },
      ),
    );

    const proc = spawn(
      xfetch<null>,
      "xfetch-stop",
    )({
      url: new URL("https://example.com/api/slow"),
      method: "GET",
    } as FetchArgs<null>);

    expect(await nextState(proc)).toMatchObject({ code: "loading" });
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // Send STOP — should trigger AbortController.abort()
    proc.send({ type: "STOP" });

    expect(await nextMessage(proc)).toMatchObject({ type: "ABORTED" });
    expect(await nextState(proc)).toMatchObject({ code: "aborted" });
    await proc.wait();

  });

  // -- state transitions -----------------------------------------------------

  it("transitions pending → loading → ok", async () => {
    const hang = withHangResponse(
      mockResponse(
        { done: true },
        { headers: { "content-type": "application/json" } },
      ),
    );

    const proc = spawn(
      xfetch<{ done: boolean }>,
      "xfetch-lifecycle",
    )({
      url: new URL("https://example.com/api/item"),
      method: "GET",
    } as FetchArgs<{ done: boolean }>);

    await proc.ready();
    expect(proc.state).toMatchObject({ code: "pending" });
    expect(await nextState(proc)).toMatchObject({ code: "loading" });

    // Resolve the fetch
    hang.resume();
    expect(mockedFetch).toHaveBeenCalledWith(
      "https://example.com/api/item",
      expect.objectContaining({
         method: 'GET',
      })

    );

    expect(await nextMessage(proc)).toMatchObject({
      type: "OK",
      data: { done: true },
    });
    expect(await nextState(proc)).toMatchObject({ code: "ok", data: { done: true } });
  });

  // -- wait() ----------------------------------------------------------------

  it("wait() resolves when the fetch completes", async () => {
    withResponse(
      mockResponse(
        { ok: true },
        { headers: { "content-type": "application/json" } },
      ),
    );

    const proc = spawn(
      xfetch<{ ok: boolean }>,
      "xfetch-wait",
    )({
      url: new URL("https://example.com/api/item"),
      method: "GET",
    } as FetchArgs<{ ok: boolean }>);

    await proc.ready();
    const waiting = proc.wait();
    await expect(waiting).resolves.toBeUndefined();
  });
});
