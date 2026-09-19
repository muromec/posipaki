// ── a payload with something to reflect on ─────────────────────────────────
//
// Serves one actor that carries the inspect plugin and a few methods of its
// own, so the client half can be asked for both a subtree and an answer.

let defineActor;
let inspect;
let serveRemoteActor;
let fifoArgvSpawner;

try {
  ({ defineActor } = await import("../../../dist/index.js"));
  ({ serveRemoteActor } = await import("../../../dist/remote/index.js"));
  ({ fifoArgvSpawner } = await import("../../../dist/remote/node.js"));
  ({ inspect } = await import("../../../dist/plugins/tree-introspection.js"));
} catch {
  console.error(
    "Posipaki remote actor failed to start.\nFailed to import, no built version of the library found.\nRun npm run build or bun run build first.\nExiting now",
  );
  process.exit(1);
}

const leaf = defineActor({
  name: "leaf",
  plugins: [], // block inheritance: the tree shows a child it cannot ask
  handlers: {
    // What it holds and what it says: both are how the far side sees that a
    // message reached it.
    async PING() {
      this.state.pings += 1;
      this.ctx.notify();
      await this.emit({ type: "PONG" });
    },
  },
  async setup() {
    return { pings: 0 };
  },
});

const reflector = defineActor({
  name: "reflector",
  plugins: [inspect()],
  $reflectionMethods: {
    async "probe.add"(a, b) {
      return a + b;
    },
    "probe.late"(ms) {
      return new Promise((resolve) => setTimeout(() => resolve(`late:${ms}`), ms));
    },
    async "probe.boom"() {
      throw new Error("probe said no");
    },
    async "probe.refusing"() {
      return () => 1;
    },
    async "probe.whatItGot"(value) {
      // What arrived, said by what it can do: over a wire a reference is parsed
      // here, and a process of this side's own comes back as itself.
      return {
        name: value?.constructor?.name ?? typeof value,
        pname: value?.pname,
        canFork: typeof value?.fork === "function",
      };
    },
  },
  async setup() {
    // A child on the public state: a process on the state crosses as a reference,
    // and the other side gets a handle on it without being told anything else.
    const kid = await this.fork(leaf, undefined, { name: "kid" });
    return { kid };
  },
  handlers: {},
});

serveRemoteActor(reflector, fifoArgvSpawner);
