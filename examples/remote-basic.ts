// ── Remote Actor POC ───────────────────────────────────────────────────────
//
// Demonstrates spawning a posipaki actor in a child process over a named fifo.
//
// Run:
//   bun run examples/remote-basic.ts

import { defineActor, defineMessages } from "../src/index.js";
import { runChild, spawnRemote } from "../src/remote/index.js";

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

const isChild = process.argv.some((a) => a.startsWith("--fifo="));

if (isChild) {
  await runChild(echoActor.fn);
} else {
  console.log("Host: spawning child...");

  const proxy = await spawnRemote({
    command: ["bun", "run", "examples/remote-basic.ts"],
    args: {},
  });

  console.log("Host: child ready, state:", proxy.state);

  const pongs: Array<{ count: number }> = [];
  proxy.onMessage((msg) => {
    if (msg.type === "PONG") pongs.push(msg as { count: number; type: string });
  });

  for (let i = 1; i <= 3; i++) {
    proxy.send({ type: "PING", count: i });
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 200));

  console.log("Host: received PONGs:", pongs.map((p) => p.count));
  console.log("Host: final state:", proxy.state);

  proxy.send({ type: "STOP" } as any);
  const result = await proxy.wait();
  console.log("Host: child exited with code", result.code);
}
