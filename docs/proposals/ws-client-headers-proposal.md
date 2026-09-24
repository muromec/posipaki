# ws-client: an opener, so a caller can connect with more than a URL

**Status:** proposal — nothing implemented.  Written from a consumer's need (email-agent's
voice service), after choosing the workaround this would replace.
**Follows:** [actor-remote-websocket.md](./actor-remote-websocket.md) for the seam, and the
implemented [xfetch-headers-proposal.md](./xfetch-headers-proposal.md), which is the same
problem on the HTTP side.

## The need, in one line

A WebSocket client spawner can be told which URL to open and which constructor to open it
with, and nothing else.  A connection that needs a header — an `Authorization` bearer, a
correlation id, a cookie — has nowhere to say so, and the consumer is left putting the
credential in the query string, which is the one part of a connection that every log line,
proxy and error message keeps a copy of.

## What exists today

```ts
export type WebSocketCtor = new (url: string) => {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
};

export function wsClientSpawner<Args = unknown>(
  url: string | ((args: Args) => string),
  WebSocketImpl: WebSocketCtor = defaultWebSocket,
): ClientSpawner<Args>;
```

and inside, `const ws = new WebSocketImpl(target);` — one argument, no options.  The `url`
may be a function of the spawn args, which is the only per-connection input the seam has;
the constructor is fixed when the spawner is built.

### It is not impossible, which is why this is a proposal and not a bug report

A caller can pass `class extends WebSocket` with the headers closed over.  One consumer does
exactly that today for TLS: the voice service's client opens with
`new WebSocket(url, { tls: { ca } })` under Bun's constructor shape
(`vendored/voice-server/src/websocket.ts`), and every place that must pin a CA carries that
piece of runtime knowledge itself.

Two things are wrong with leaving it there:

1. **It is a class per connection shape, not a function of the connection.**  Headers can
   only be closed over when the spawner is built, so a token that varies per spawn — per
   args, per tenant, per tenant named in args — cannot be attached at all.  The seam has no
   way to hand `args` to the constructor.
2. **The runtime's argument shape leaks into every consumer.**  `new WebSocket(url, options)`
   is Bun's; it is `new WebSocket(address, protocols, options)` in node's `ws`; in a browser
   or a service worker there is no options argument at all.  A consumer that wants headers
   writes runtime-specific code in a file whose own header comment says that
   environment-specific work is the spawner's business.

## Direction

The second parameter is what opens the socket, so let it be a function that opens one:
`(url, args) => socket`.  A constructor becomes the default opener; a caller with headers
passes its own.

```ts
/** The socket shape the spawner needs: the transport's fields plus the open/error slots. */
export type OpenedWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
};

export type WebSocketCtor = new (url: string) => OpenedWebSocket;
export type WebSocketOpener<Args = unknown> = (url: string, args: Args) => OpenedWebSocket;

export function wsClientSpawner<Args = unknown>(
  url: string | ((args: Args) => string),
  WebSocketImpl?: WebSocketCtor,
  opts?: { open?: WebSocketOpener<Args> },
): ClientSpawner<Args>;
```

`open`, when given, wins; `WebSocketImpl` remains what the default opener constructs, so
every existing call — tests with a fake, a consumer with a subclass — behaves as it does
now.  The named `OpenedWebSocket` is not new typing, only the shape that is inline today.

The three runtimes, as callers:

```ts
// Bun — TLS and headers in one object (what the voice service runs)
wsClientSpawner(url, undefined, {
  open: (target) => new WebSocket(target, {
    tls: { ca },
    headers: { authorization: `Bearer ${token}` },
  }),
});

// node ws
wsClientSpawner(url, undefined, {
  open: (target) => new WebSocket(target, [], {
    headers: { authorization: `Bearer ${token}` },
  }),
});

// browser / service worker — nothing to configure beyond the URL, default opener
wsClientSpawner(url);
```

With `args` in the opener's signature, a header that varies per spawn is expressible:

```ts
wsClientSpawner<{ tenant: string }>(url, undefined, {
  open: (target, args) => new WebSocket(target, { headers: { 'x-tenant': args.tenant } }),
});
```

### The server half needs nothing

`wsServerSpawner(ws)` is handed a socket that is already upgraded, and the consumer's HTTP
layer is what upgrades it — so the request headers are where they always were, in the
consumer's `upgrade` handler, and a served actor can be authenticated there before
`serveRemoteActor` is called.  This proposal is client-side only.  The consumer's plan for
the voice service is exactly that: `server.on('upgrade')` reads `authorization`, refuses the
connection without it, and only then hands the socket to the spawner.

## Alternatives considered

1. **`headers?: Record<string, string>` on the spawner** — the shape xfetch got, one word
   shorter at the call site.  Rejected for ws: xfetch owns the request, so headers are data
   it can carry; a ws constructor belongs to the runtime and takes a different argument in
   each.  A `headers` field would be the first of a series — `ca` next, then `agent`, then
   `protocols` — each of which posipaki would have to be taught in every runtime's shape.
2. **A second factory, `wsClient(url, open)`** — two entry points for one thing, and the
   existing signature has to keep working anyway.
3. **The token in the query string** — what the consumer is doing meanwhile, recorded as
   debt on its side.  It works with today's `url` factory and no change here; it puts a
   bearer token in the part of a connection that is logged by default.  Not refused by
   posipaki — the transport does not read URLs and should not start — just not a shape
   anyone wants to keep.

## Open questions

1. **Opener or connector?**  `actor-remote-websocket.md` sketches `wsConnector(url)`.  If
   the intent is a factory over this seam, the third-argument `open` is the smallest step
   and a connector can be built on top later.
2. **Does the opener want `args`?**  Recommended yes, for per-spawn headers.  It is additive
   if a later version wants a richer context object instead.
3. **Does the opener need to see a refused upgrade?**  Today `openWebSocket` owns
   `onopen`/`onerror`, and a 401 from the server surfaces as `websocket failed to open: …`.
   A richer error is worth its own proposal; this one keeps the failure path as it is.
4. **Should `WebSocketImpl` and `open` both exist?**  They overlap — an opener can replace a
   subclass entirely — but `WebSocketImpl` is a published parameter with callers, and the
   default opener needs a constructor from somewhere.

## What the consumer does when it lands

The voice seam switches the token from the query string to an `authorization` header, the
debt note on that side is deleted, and the runtime-specific TLS wrapper it carries today
collapses into one opener passed at spawn.
