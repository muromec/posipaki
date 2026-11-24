// ── the process a node is served by ─────────────────────────────────────────
//
// What a served process looks like from inside: it is handed a term and who asked, it prints them, and it answers by
// sending a term back to a reference. It never sees an address — and the reference it answers need not be the asker:
// a term can carry another process, and this one answers that.

import { defineActor, defineMessages } from "posipaki";

import { processTerm, remoteTerm, show, type VisibleTerm } from "../src/processes.js";
import type { RemoteProcess } from "../src/processes.js";
import type { Asked } from "../src/served.js";
import { atom, binary, tuple } from "../src/terms.js";

/** The process a term names, when it names one: `{Pid, …}` is how a peer hands over who to answer. */
function namedIn(body: VisibleTerm): RemoteProcess | null {
  if (body.kind !== "tuple") return null;
  const first = body.items[0];
  return first?.kind === "remote" ? first.process : null;
}

/** Says what it was asked, and answers the process it names, or the asker when it names none. */
export const Answerer = defineActor({
  name: "answerer",
  inMessages: defineMessages<Asked>(),
  outMessages: defineMessages<never>(),
  handlers: {
    ETF_RAW(asked: Asked) {
      console.log(`  asked by ${show(remoteTerm(asked.from))}: ${show(asked.body)}`);
      const to = namedIn(asked.body) ?? asked.from;
      const words = process.env.POSIPAKI_WORDS ?? "answering";
      void to.send(tuple(processTerm(this.self), binary(Buffer.from(words, "utf8")), atom("done")));
    },
  },
});
