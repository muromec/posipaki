import { defineActor } from "../src/index";
import { pipe } from "../src/pipe";

const timer = setTimeout(() => null, 1000 * 30);

const worker = defineActor({
  initialState(args: { number: number }): {
    done: boolean;
    result: { number: number } | null;
  } {
    return { done: false, result: null };
  },
  onStart(args) {
    console.log("run f1", args.number);
    setTimeout(() => this.emit({ type: "POKE" }), 100 * args.number);
  },
  handlers: {
    POKE() {
      this.state.done = true;
      this.state.result = { number: (this.state as any)._number * 2 };
      this.agreeToStop();
    },
  },
  onEnd() {
    console.log("gone");
  },
});

const main = defineActor({
  initialState: { done: false },
  onStart() {
    const worker2 = worker.fn;
    const worker3 = worker.fn;
    const child = this.ctx.fork(pipe([worker.fn, worker2, worker3]), "w")({
      number: 1,
    });
  },
  handlers: {},
  onChildExit(name) {
    this.state.done = true;
    // child state available via this.$child[name].state
  },
});

const m = main.spawn(null);
setTimeout(() => m.send({ type: "STOP" } as any, { fromName: "external", fromId: Symbol("external") }), 300);
await m.wait();
clearTimeout(timer);
