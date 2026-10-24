# xfetch as a pipe

> Status: **proposal** (2026-10-24). Lands as **0.47.0**: `FetchArgs` changes shape, which is breaking on a
> 0.x line.

## The problem

A request that took 760 s was killed at 300 s, and the layer that killed it was three floors down: Bun's
HTTP client has a socket **idle** deadline, five minutes by default, reset on every byte sent or received.
A non-streaming inference request is idle for the whole generation, so it dies at the deadline.

That would have been a two-minute diagnosis had the failure carried its cause. It did not: `xfetch`
catches the exception and emits `{ type: "ERROR" }` with nothing on it. The caller logged the only sentence
it could — "API request failed" — and went looking at the network.

Neither of those is a bug in `xfetch`'s mechanics. They are what a pipe does when it decides things.

## What it decides today

In `src/xfetch.ts`:

- **The method** (17-29): a closed set of GET/POST/PUT/PATCH. DELETE and HEAD cannot be expressed.
- **The body** (98): `JSON.stringify(body)` for every non-GET.
- **A header you did not send** (100-102): `content-type: application/json` when the caller set none.
- **The response's shape** (53-56, 111-117): it parses the body itself, deciding by an exact
  `content-type === "application/json"` test — so `application/json; charset=utf-8` falls through to text,
  and a malformed body throws *inside* the child and is reported as `ERROR`, indistinguishable from a
  socket failure.
- **A second copy of the answer** (8-14, 127-138): `code/data/text/status/responseHeaders`, where
  `state.data = msg.data || null` turns a legitimate `0`, `false` or `""` into `null`.
- **The cause** (118-125): discarded.
- **The deadline**: not expressible. There is nowhere in `FetchArgs` to put one, which is why the default
  was the only one we had.

## The shape

```ts
export type FetchInit = RequestInit & {
  /** Bun's socket idle deadline, in ms (`false`/`0` disables it).  Ignored by runtimes that lack it. */
  timeout?: number | boolean;
};

export type FetchArgs = { url: URL; init?: FetchInit };

export type FetchMessage =
  | { type: 'OK'; text: string; status: number; responseHeaders: Record<string, string> }
  | { type: 'ERROR'; reason: string }
  | { type: 'LOADING' }
  | { type: 'ABORTED' }
  | { type: 'STOP' }
  | ExitMessage;
```

- The init is handed to `fetch` untouched. The caller decides the method, the body, the content type, the
  redirect policy, and the deadline.
- The answer is **text**, with the status and the headers.
- A failure carries **the cause**, in words.
- It stays a **process**: a request that runs for minutes must not hold its caller's loop, and `STOP` must
  still abort it. That part was load-bearing, not decoration.

## What it does not do

No parsing, no sniffing, no body shaping, no retrying, no redirect policy of its own, no streaming. A
stream cannot cross a message boundary cheaply; `stream: true` wants a channel, which is a different
proposal.

## Decisions

- **Text, not bytes.** An API call wants text, and the reader of a message cannot be handed a stream.
  Binary bodies are the streaming slice's problem, and every current caller wants text.
- **`timeout` is passed through even though it is not in `RequestInit`.** It is the only place a caller can
  raise Bun's idle deadline; on a runtime without it the field is simply ignored by `fetch`.
- **GET with a body is allowed.** The platform refuses it if it refuses it; that is not a pipe's opinion.

## Cost

Breaking for `FetchArgs`: a caller moves from `{ url, method, body, headers }` to `{ url, init }`. Today
that is one call site in the harness (the OpenAI connector) plus the tests here. The harness stays on
0.46.1 until the publish and its own bump, so nothing breaks in place.
