import { defineActor } from "../src/index";

const timer = setTimeout(() => null, 1000 * 30);

const fast = defineActor({
  initialState: true,
  handlers: {},
  onStopRequested() {
    this.agreeToStop();
  },
});

const slow = defineActor({
  initialState: { done: false },
  async onStart() {
    setTimeout(() => this.emit({ type: "FIRED" } as any), 10 * 1000);
  },
  handlers: {
    FIRED() {
      this.state.done = true;
      this.agreeToStop();
    },
  },
});

const main = defineActor({
  initialState: { done: false },
  onStart() {
    this.ctx.fork(fast.fn, "f1")(null);
    const timerProc = this.ctx.fork(slow.fn, "timer2")(null);
  },
  handlers: {},
  onChildExit(name) {
    if (name === "timer2") {
      this.state.done = true;
    }
  },
  onEnd() {
    // done
  },
});

const m = main.spawn(null);
await m.wait();
clearTimeout(timer);
