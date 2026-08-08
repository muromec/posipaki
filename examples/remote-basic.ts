// ── Remote Actor POC — stable, no hangs, no EBADF ─────────────────────────
//
// Demonstrates defineRemoteActor — one import, both ends of the wire.
//
// Run:
//   bun run examples/remote-basic.ts

import { defineActor, defineMessages } from "../src/index.js";
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

const remoteEcho = defineRemoteActor(echoActor.fn, import.meta.url);

if (!remoteEcho.isChild) {
  console.log("Host: spawning child...");

  const proxy = await remoteEcho.spawn({});

  console.log("Host: child ready, state:", proxy.state);

  const pongs: Array<{ count: number }> = [];
  proxy.onMessage((msg: any) => {
    if (msg.type === "PONG") pongs.push(msg);
  });

  for (let i = 1; i <= 3; i++) {
    proxy.send({ type: "PING", count: i } as any);
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 200));

  console.log("Host: received PONGs:", pongs.map((p: any) => p.count));
  console.log("Host: final state:", proxy.state);

  proxy.send({ type: "STOP" } as any);
  const result = await proxy.wait();
  console.log("Host: child exited with code", result.code);
}
