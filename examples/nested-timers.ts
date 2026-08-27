import { defineActor } from "../src/index";

// Keep the script from exiting immediately while the demo runs.
const timer = setTimeout(() => null, 1000 * 30);

const fast = defineActor({
  name: "fast",
  setup() {
    return true;
  },
  handlers: {},
  onStopRequested() {
    this.agreeToStop();
  },
});

const slow = defineActor({
  name: "slow",
  setup() {
    return { done: false };
  },
  afterStart() {
    setTimeout(() => this.ctx.sendSelf({ type: "FIRED" }), 10 * 1000);
  },
  handlers: {
    FIRED() {
      this.state.done = true;
      this.agreeToStop();
    },
  },
});

const main = defineActor({
  name: "main",
  setup() {
    return { done: false };
  },
  async afterStart() {
    await this.fork(fast, null);
    await this.fork(slow, null);
  },
  handlers: {},
  onChildExit(name) {
    if (name === "main:slow") {
      this.state.done = true;
      this.agreeToStop();
    }
  },
  onStopRequested() {
    this.agreeToStop();
  },
});

const m = await main.spawn(null);
await m.wait();
clearTimeout(timer);
