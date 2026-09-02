let defineActor;
let serveRemoteActor;
let fifoArgvSpawner;

try {
  ({ defineActor } = await import("../../../dist/index.js"));
  ({ serveRemoteActor } = await import("../../../dist/remote/index.js"));
  ({ fifoArgvSpawner } = await import("../../../dist/remote/node.js"));
} catch {
  console.error(
    "Posipaki remote actor failed to start.\nFailed to import, no built version of the library found.\nRun npm run build or bun run build first.\nExiting now",
  );
  process.exit(1);
}

const echoActor = defineActor({
  name: "echo",
  setup: () => ({ pings: 0 }),
  handlers: {
    async PING(msg) {
      this.state.pings++;
      await this.emit({ type: "PONG", count: msg.count });
    },
  },
});

serveRemoteActor(echoActor, fifoArgvSpawner);
