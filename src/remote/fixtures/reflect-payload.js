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

// What a process on the other end does about a message is not answered by the
// wire: it arrives when it arrives, so a method that wants to see it waits.
const until = async (predicate, what) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`reflect-payload: timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// What arrived in the last message, kept so a call can ask about it later.
let kept = null;

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

// A child that inherits the inspect plugin, so a search for it from the far side can
// answer with a handle whose methods are worth asking for.
const watcher = defineActor({
  name: "watcher",
  setup: () => ({ ticks: 0 }),
  handlers: {},
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
    async "probe.poke"(handle) {
      // A process of the far side's own, handed over to this side.  Sending to it
      // is a message going the other way, and what it does about it comes back on
      // the stream that started when it crossed — which is the only reason this
      // method can answer at all.
      //
      // Nothing here owns it yet: a reference that arrives to be passed on is nobody's
      // until somebody keeps it, and only a kept one can be heard from.  Whoever receives
      // it is the one to deal with it, so this keeps it for the length of the call and
      // gives the count back at the end.
      const mine = handle.holdRef();
      const heard = [];
      const stop = handle.subscribe("message", (msg) => heard.push(msg.type));
      // Subscribing to what it says is half of it: a process that crossed is silent
      // about what it holds too, and this method reads that as well.
      handle.tune(["message", "state"]);
      handle.send({ type: "PING" });
      // Both of them: what it holds and what it says are two frames, and either
      // can be the one that arrives first.
      await until(
        () => handle.state?.pings === 1 && heard.length > 0,
        "the state it streamed and the message it sent",
      );
      stop();
      const answer = { heard, pings: handle.state?.pings };
      mine.releaseRef();
      return answer;
    },
    async "probe.ask"(handle, method, args) {
      // A method of a process of the far side's own, asked from here.  What it can
      // answer is announced on its own frame, which comes after the one that carried
      // the reference, so the surface is waited for rather than assumed.
      await until(
        () => typeof handle.$reflection?.[method] === "function",
        `the announcement of ${method}`,
      );
      return await handle.$reflection[method](...args);
    },
    async "probe.boom"() {
      throw new Error("probe said no");
    },
    async "probe.refusing"() {
      return () => 1;
    },
    async "probe.finish"(handle) {
      // Asked from over there to end a process of its own: the exit crosses back
      // the way everything else about it does, which is what this waits for.
      await handle.stop();
      return { ended: handle.hasEnded() };
    },
    async "probe.kept"() {
      // What the last message carried, said by what it can do.
      return kept ? { pname: kept.pname, canSend: typeof kept.send === "function" } : null;
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
    await this.fork(watcher, undefined, { name: "watcher" });
    return { kid };
  },
  handlers: {
    async KEEP(msg) {
      // A process handed over inside a message body: the walk puts a handle in its
      // place before the actor is given the message at all.
      kept = msg.kid ?? null;
      await this.emit({ type: "KEPT" });
    },
  },
});

serveRemoteActor(reflector, fifoArgvSpawner);
