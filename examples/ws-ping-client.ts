// ── The ping client: an actor served somewhere else ──────────────────────────
//
// The other half of `ws-ping-server.ts`, and the same client a Python server is
// spoken to with: what crosses is frames, not code, so the far side can be
// posipaki in another process, in another language — `pysipaki` serves this very
// ping pong in Python.
//
//   PING_TOKEN=… bun run examples/ws-ping-client.ts --count 3
//
// Options come from the command line first and the environment after it:
//
//   --url    PING_URL      where the server is (default ws://127.0.0.1:8790/)
//   --token  PING_TOKEN    the shared secret, sent as `?token=` (the spawner
//                          takes a URL and nothing else today)
//   --count  PING_COUNT    how many pings to send (default 1)

import { remoteClient } from "../src/remote/client.js";
import { wsClientSpawner } from "../src/remote/spawners/ws-client.js";

type PingIn = { type: "PING"; count: number };
type ProxyIn = PingIn | { type: "STOP" };
type PongOut = { type: "PONG"; count: number };

function flag(name: string, env: string, fallback: string): string {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  if (at >= 0) return argv[at + 1] ?? "";
  return process.env[env] ?? fallback;
}

const url = flag("url", "PING_URL", "ws://127.0.0.1:8790/");
const token = flag("token", "PING_TOKEN", "");
const count = Number(flag("count", "PING_COUNT", "1"));
const where = token
  ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
  : url;

const proxy = remoteClient<unknown, { pings: number }, ProxyIn, PongOut>(
  "echo",
  wsClientSpawner(where),
);
const proc = await proxy.spawn({});
await proc.ready();
console.log(`connected: ${url} — the far side holds ${JSON.stringify(proc.state)}`);

const pongs: number[] = [];
proc.subscribe("message", (message) => {
  // One stream carries everything said about the process: the actor's own
  // messages, and posipaki's notices about it (a child's EXIT, for one).  This
  // example wants the pongs.
  const said = message as { type?: string };
  if (said.type !== "PONG") return;
  pongs.push((message as PongOut).count);
});

for (let ping = 1; ping <= count; ping += 1) proc.send({ type: "PING", count: ping });
proc.send({ type: "STOP" });
await proc.wait();

console.log(`pongs: ${pongs.join(", ")} — it held ${JSON.stringify(proc.state)}`);
