import { spawnAsync, runDispatch } from "../src/index";
import { supervise, attach } from "../src/supervisor";
import { xfetch } from "../src/xfetch";

import { reactive, computed, watch } from "vue";

async function* main({ pname, fork }) {
  const state = reactive<{ s: any; r: string | null }>({ s: null, r: null });
  yield state;

  const s = fork(supervise, "super")(reactive, true);
  const urls = [new URL("https://api.myip.com"), new URL("https://x.myip.com")];
  for (const url of urls) {
    attach(s, xfetch, `xfetch ${url.href}`)({ url });
  }

  state.s = s;

  yield* runDispatch(
    pname,
    ([msg, _sender]) => {
      if (msg.type === "STOP" || msg.type === "EXIT") {
        state.s = null;
      }
      if (msg.type === "OK") {
        state.r = (msg as any).text;
      }
    },
    () => !state.s,
    true,
  );
}

const m = spawnAsync(main, "main")(null);
const states = computed(() => {
  if (!m.state.s) return null;
  return m.state.s.state.processes.map((p: any) => p.state);
});
watch(states, (value) => console.log("s", value), { immediate: true });
watch(m.state, () => console.log("m", m.state.r));

await m.wait();
