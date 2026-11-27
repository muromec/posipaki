// ── the process a node is served by ─────────────────────────────────────────
// What a served process looks like from inside: it is handed a term, it prints what it carries, and it answers the
// process the term itself names — not the one that asked — which is what makes an answer from one node reach a second
// one. It never sees an address.
//
// The words it knows are a table: `hi` is answered, and `exit` ends the process, so a peer watching it reads a DOWN.
// Two of these facing each other would otherwise answer each other for ever, each term naming the other side: the same
// rule `robot.erl` keeps, and for the same reason.

import { defineActor, defineMessages } from "posipaki";

import type { EtfTerm } from "../src/node.js";
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

/** A word this process knows: the answer it sends, or the reason it ends with. */
type Word = { readonly answer: string } | { readonly ends: string };

/** The words it knows, by what a term carries. A word not here is printed and left alone. */
const dispatch: Record<string, Word> = {
  hi: { answer: process.env.POSIPAKI_WORDS ?? "answering" },
  exit: { ends: "asked to" },
};

/** Says what it was asked, and does what the word asks: answers the process the term names, or ends. */
export const Answerer = defineActor({
  name: "answerer",
  inMessages: defineMessages<EtfTerm>(),
  outMessages: defineMessages<never>(),
  handlers: {
    async ETF_RAW(asked: EtfTerm) {
      console.log(`  asked: ${show(asked.body)}`);
      const to = namedIn(asked.body);
      const word = wordIn(asked.body);
      if (to === null || word === null) {
        console.log("  and nothing to answer: the term names no process, or carries no word");
        return;
      }
      const known = dispatch[word];
      if (known === undefined) {
        console.log(`  and nothing to answer: ${word} is not a word this process knows`);
        return;
      }
      if ("ends" in known) {
        console.log(`  ${word}: this process ends, and a peer watching it is told why`);
        this.exit(known.ends);
        return;
      }
      // The address is the term's, and answering is a send of this actor's own: nothing here emits.
      await to.send(tuple(processTerm(this.self), binary(Buffer.from(known.answer, "utf8")), atom("done")));
    },
  },
});
