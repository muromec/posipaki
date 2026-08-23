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
    // echoActor.fn,
    remoteEcho.fn,
    "echo",
    (msg) => {
      const [body] = msg;
      if (body.type === "PONG") pongs.push(body);
    },
  )({});

  await proc.ready();

  proc.send({ type: "PING", count: 1 });
  proc.send({ type: "PING", count: 2 });
  proc.send({ type: "PING", count: 3 });
  proc.send({ type: "STOP" });

  await proc.wait();

  console.log(
    "Host: received PONGs:",
    pongs.map((p) => p.count),
  );
  console.log("Host: remote state:", proc.state);
}
