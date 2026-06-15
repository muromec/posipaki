import { defineActor } from "../src/index";
import { supervise, attach } from "../src/supervisor";
import { xfetch } from "../src/xfetch";
import { reactive, computed, watch } from "vue";

const main = defineActor({
  initialState(): { s: any; r: string | null } {
    return { s: null, r: null };
  },
  expose(state) {
    return reactive(state);
  },
  async onStart() {
    const s = this.ctx.fork(supervise, "super")(reactive, true);
    const urls = [new URL("https://api.myip.com"), new URL("https://x.myip.com")];
    for (const url of urls) {
      attach(s, xfetch, `xfetch ${url.href}`)({ url });
    }
    this.state.s = s;
  },
  handlers: {
    STOP() {},
    EXIT() {
      this.state.s = null;
    },
    OK(msg) {
      this.state.r = (msg as any).text;
    },
  },
  onEnd() {
    this.state.s = null;
  },
});

const m = main.spawn(null);
const states = computed(() => {
  if (!m.state.s) return null;
  return m.state.s.state.processes.map((p: any) => p.state);
});
watch(states, (value) => console.log("s", value), { immediate: true });
watch(m.state, () => console.log("m", m.state.r));

await m.wait();
