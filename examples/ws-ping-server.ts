// ── The ping actor, served over WebSocket ────────────────────────────────────
//
// The other half of `ws-ping-client.ts`: posipaki's remote server in a Bun
// process, with an actor behind it, so the same ping pong can be played from a
// client that is not posipaki at all — `pysipaki` is the Python side of exactly
// this seam, and serves and spawns the same frames.
//
//   PING_SECRET=… bun run examples/ws-ping-server.ts --port 8790
//
// Options come from the command line first and the environment after it:
//
//   --port    PING_PORT    what to listen on (default 8790)
//   --secret  PING_SECRET  the shared secret, if one is wanted (default: none)
//
// A guard is the application's business rather than the library's — nothing in
// posipaki checks a secret — so the check is here, in the upgrade request, and it
// reads the secret from the header or, because a browser's WebSocket cannot set
// one, from the query.

import { timingSafeEqual } from "node:crypto";

import { defineActor, defineMessages } from "../src/index.js";
import { serveRemoteActor } from "../src/remote/server.js";
import {
  bunServerWebSocket,
  wsServerSpawner,
  type BunServerWebSocketLike,
} from "../src/remote/spawners/ws-server.js";
import type { WebSocketLike } from "../src/remote/transports/websocket.js";

type PingIn = { type: "PING"; count: number };
type PongOut = { type: "PONG"; count: number };

const pingActor = defineActor({
  name: "echo",
  inMessages: defineMessages<PingIn>(),
  outMessages: defineMessages<PongOut>(),
  setup: () => ({ pings: 0 }),
  handlers: {
    PING(msg: PingIn) {
      this.state.pings += 1;
      this.emit({ type: "PONG", count: msg.count });
    },
  },
});

function flag(name: string, env: string, fallback: string): string {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  if (at >= 0) return argv[at + 1] ?? "";
  return process.env[env] ?? fallback;
}

/** What the upgrade request presented, whichever way it could. */
function presented(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return new URL(request.url).searchParams.get("token") ?? "";
}

/** Whether it presented the secret — compared without leaking where it differs. */
function authorised(request: Request, secret: string): boolean {
  const given = Buffer.from(presented(request));
  const wanted = Buffer.from(secret);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// Bun is not typed in this repository (the library never touches it), so the two
// things this server uses are named here, as the tests name them.
interface ServeOptions {
  port: number;
  fetch(request: Request, server: { upgrade(request: Request): boolean }): Response | undefined;
  websocket: {
    open(ws: BunServerWebSocketLike): void;
    message(ws: BunServerWebSocketLike, message: string): void;
    close(ws: BunServerWebSocketLike): void;
  };
}
interface Served {
  port: number;
}
const BunRt = (globalThis as unknown as { Bun: { serve(options: ServeOptions): Served } }).Bun;

const port = Number(flag("port", "PING_PORT", "8790"));
const secret = flag("secret", "PING_SECRET", "");

const server = BunRt.serve({
  port,
  fetch(request, server_) {
    if (secret && !authorised(request, secret)) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (server_.upgrade(request)) return undefined;
    return new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    open(ws) {
      // One actor per connection, served over the socket as it arrives.
      const adapter = bunServerWebSocket(ws);
      ws.data = adapter;
      void serveRemoteActor(pingActor, wsServerSpawner(adapter));
    },
    message(ws, message) {
      (ws.data as WebSocketLike).onmessage?.({ data: message });
    },
    close(ws) {
      (ws.data as WebSocketLike).onclose?.();
    },
  },
});

console.log(`serving the ping actor on ws://127.0.0.1:${server.port}/${secret ? " (guarded)" : ""}`);
