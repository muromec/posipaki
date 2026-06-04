# xfetch: Custom Request Headers Support — implemented ✅

> **Status**: Implemented. This document captures the original proposal,
> what was built, and how each open question was resolved.

## Summary

Add an optional `headers` field to xfetch's `FetchArgs` so callers can pass
custom HTTP headers (e.g. `Authorization`, `User-Agent`, `Accept`). The
original implementation constructed a fresh `Headers` object internally and
only set `Content-Type` — there was no way to add headers from outside.

## Motivation

Many HTTP APIs require custom headers — `Authorization` for auth,
`User-Agent` for identification, `Accept` for content negotiation.
xfetch's old API constructed a fresh `Headers` object internally and
only set `Content-Type`, making it impossible to use with any API that
needs auth or custom headers.

## What was built

Two changes in `src/xfetch.ts`:

### Type changes (`FetchArgs<T>`)

`headers?: Record<string, string>` added to both branches:

```ts
export type FetchArgs<T> =
  | {
      url: URL;
      method?: "GET";
      body?: undefined;
      headers?: Record<string, string>;
    }
  | {
      url: URL;
      method?: "POST" | "PUT" | "PATCH";
      body: T;
      headers?: Record<string, string>;
    };
```

### Implementation change (in `doRequest`)

Caller headers are passed to the `Headers` constructor, then xfetch's
`Content-Type` is set on top — the `set` call always wins:

```ts
const headers = new Headers(callerHeaders ?? {});
if (serializedBody) {
  headers.set("content-type", "application/json");
}
```

### Caller example

```ts
ctx.forkSync(xfetch, "api-call")({
  method: "POST",
  url: new URL("https://api.example.com/v1/thing"),
  body: { key: "value" },
  headers: {
    "Authorization": "Bearer <token>",
    "User-Agent": "my-app/1.0",
  },
});
```

## Backward Compatibility

Fully backward-compatible. `headers` is optional — omitting it produces
identical behaviour to the previous implementation. Verified by test:
*"omitting headers behaves identically to current behaviour"*.

## Resolution of open questions

### Should xfetch validate header names?

> The `Headers` constructor already rejects invalid names with a `TypeError`.

**Resolved**: No extra validation added. The `Headers` constructor handles
this — invalid header names produce a `TypeError` which falls into the
existing `catch` block and results in an `ERROR` message. Sufficient.

### Should `LOADING` expose response headers?

> Could be useful for rate-limit headers (`X-RateLimit-Remaining`).

**Resolved**: Out of scope for this change. Can be revisited as a separate
proposal.

## Additional changes

- `runDispatch` debug logging was turned off (`true` → `false`) since it
  produced noisy `msg xfetch-... <- ...` output on every message.
- `ProcessCtx` type arguments were fixed to include all four required
  parameters (`Args`, `State`, `IM`, `OM`).
- Tests were added (`src/xfetch.test.ts`) covering the existing xfetch
  behavior (GET, POST, errors, abort, state transitions) plus the new
  headers functionality (custom headers on GET, custom headers on POST,
  Content-Type override, omitted headers).

## Implementation Checklist

- [x] Add `headers?: Record<string, string>` to both branches of `FetchArgs<T>`
- [x] Pass `args.headers` to `new Headers()` in the `doRequest` closure
- [x] Add a test: xfetch with custom `Authorization` header → server
      sees the header
- [x] Add a test: xfetch without `headers` → behaviour unchanged
- [x] ~~Update TypeScript types in `xfetch.d.ts`~~ (no separate `.d.ts` exists;
      types are inline in `xfetch.ts`)
- [ ] Bump patch version