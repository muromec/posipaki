// ── Remote Actor POC — stable, no hangs, no EBADF ─────────────────────────
//
// Demonstrates defineRemoteActor — one import, both ends of the wire.
// Returns a real ActorDefinition, interchangeable with defineActor.
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

const remoteEcho = defineRemoteActor(echoActor, import.meta.url);

if (!remoteEcho.isChild) {
  console.log("Host: spawning child...");

  const proc = remoteEcho.spawn({});
  await proc.ready();

  console.log("Host: child ready");

  const send = (msg: any) => proc.send(msg, { fromName: "host", fromId: Symbol() });

  send({ type: "PING", count: 1 });
  send({ type: "PING", count: 2 });
  send({ type: "PING", count: 3 });
  await new Promise((r) => setTimeout(r, 200));

  send({ type: "STOP" });
  await proc.wait();
  console.log("Host: child exited");
}
