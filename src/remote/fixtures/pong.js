import { defineActor } from "../../index.js";
import { runChild } from "../child.js";

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

runChild(echoActor.fn);
