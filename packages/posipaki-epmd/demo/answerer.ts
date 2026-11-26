// ── the process a node is served by ─────────────────────────────────────────
// What a served process looks like from inside: it is handed a term, it prints what it carries, and it answers the
// process the term itself names — not the one that asked — which is what makes an answer from one node reach a second
// one. It never sees an address.
//
// It answers one word. Two of these facing each other would otherwise answer each other for ever, each term naming the
// other side: the same rule `robot.erl` keeps, and for the same reason.

import { defineActor, defineMessages } from "posipaki";

import type { EtfAnswered, EtfAsked } from "../src/node.js";
import { processTerm, show, type ErlangProcess, type VisibleTerm } from "../src/processes.js";
import { atom, binary, tuple } from "../src/terms.js";

/** The word the term carries, when it carries one: `{Pid, Text}` is how a peer asks. */
function wordIn(body: VisibleTerm): string | null {
  if (body.kind !== "tuple") return null;
  const last = body.items[body.items.length - 1];
  return last?.kind === "binary" ? last.bytes.toString("utf8") : null;
}

/** The process a term names, when it names one: the first item of `{Pid, …}`. */
function namedIn(body: VisibleTerm): ErlangProcess | null {
  if (body.kind !== "tuple") return null;
  const first = body.items[0];
  return first?.kind === "remote" ? first.process : null;
}

/** Says what it was asked, and answers the process the term names when the word is `hi`. */
export const Answerer = defineActor({
  name: "answerer",
  inMessages: defineMessages<EtfAsked>(),
  outMessages: defineMessages<EtfAnswered>(),
  handlers: {
    ETF_RAW(asked: EtfAsked) {
      console.log(`  asked: ${show(asked.body)}`);
      const to = namedIn(asked.body);
      if (to === null) {
        console.log("  and nothing to answer: the term names no process");
        return;
      }
      if (wordIn(asked.body) !== "hi") {
        console.log("  and nothing to answer: only a hi is answered");
        return;
      }
      const words = process.env.POSIPAKI_WORDS ?? "answering";
      this.emit({
        type: "ETF_RAW",
        to,
        body: tuple(processTerm(this.self), binary(Buffer.from(words, "utf8")), atom("done")),
      });
    },
  },
});
