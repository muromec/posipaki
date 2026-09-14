// ── Remote Actor — one module, both ends of the wire ───────────────────────
//
// Demonstrates defineSubprocessActor: the actor is wrapped so that spawning it runs
// it in a child process over a fifo pair, and this same file is the child's entry
// point.  The path is ours to name (`import.meta.url`), and which end we are is
// decided by an argv marker — never by asking a module where it sits, which is the
// question a bundler makes unanswerable.
//
// Run:
//   bun run examples/remote-basic.ts

import { defineActor, defineMessages, spawnAsync } from "../src/index.js";
import { defineSubprocessActor } from "../src/remote/define-subprocess.js";

const echoActor = defineActor({
  name: "echo",
  inMessages: defineMessages<{ type: "PING"; count: number }>(),
  outMessages: defineMessages<{ type: "PONG"; count: number }>(),
  setup: () => ({ pings: 0 }),
  handlers: {
    PING(msg) {
      this.state.pings++;
      this.emit({ type: "PONG", count: msg.count });
    },
  },
});

const { actor: remoteEcho, isRemoteRoot } = defineSubprocessActor(echoActor, import.meta.url);

if (!isRemoteRoot) {
  console.log("Host: spawning child...");

  const pongs: Array<{ type: "PONG"; count: number }> = [];
  const proc = spawnAsync(remoteEcho.fn, "echo", (msg) => {
    if (msg.type === "PONG") pongs.push(msg);
  })({});

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
