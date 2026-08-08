// ── Remote Actor POC — stable, no hangs, no EBADF ─────────────────────────
//
// Demonstrates defineRemoteActor — one import, both ends of the wire.
// Uses spawnAsync with a toParent callback to collect emitted PONGs.
//
// Run:
//   bun run examples/remote-basic.ts

import { defineActor, defineMessages, spawnAsync } from "../src/index.js";
import { defineRemoteActor } from "../src/remote/define.js";

const echoActor = defineActor({
  name: "echo",
  inMessages: defineMessages<{ type: "PING"; count: number }>(),
  outMessages: defineMessages<{ type: "PONG"; count: number }>(),
  initialState: () => ({ pings: 0 }),
  handlers: {
    PING(msg) {
      this.state.pings++;
      this.emit({ type: "PONG", count: msg.count });
    },
  },
});

const { actor: remoteEcho, isRemoteRoot } = defineRemoteActor(echoActor, import.meta.url);

if (!isRemoteRoot) {
  console.log("Host: spawning child...");

  const pongs: Array<{ type: "PONG"; count: number }> = [];
  const proc = spawnAsync(
    remoteEcho.fn,
    "remote-echo",
    (msg) => {
      const [body] = msg;
      if (body.type === "PONG") pongs.push(body);
    },
  )({});

  await proc.ready();
  console.log("Host: child ready");

  const send = (msg: any) => proc.send(msg, { fromName: "host", fromId: Symbol() });

  send({ type: "PING", count: 1 });
  await new Promise((r) => setTimeout(r, 200));
  send({ type: "PING", count: 2 });
  await new Promise((r) => setTimeout(r, 200));
  send({ type: "PING", count: 3 });
  await new Promise((r) => setTimeout(r, 200));

  console.log("Host: received PONGs:", pongs.map((p: any) => p.count));

  send({ type: "STOP" });
  await proc.wait();
  console.log("Host: child exited");
}
