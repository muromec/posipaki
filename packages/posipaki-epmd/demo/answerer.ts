// ── the process a node is served by ─────────────────────────────────────────
// What a served process looks like from inside: it is handed a term, it prints what it carries, and it answers the
// process the term itself names — not the one that asked — which is what makes an answer from one node reach a second
// one. It never sees an address.
//
// The words it knows are its methods: `hi` and `whois` answer, and `exit` ends the process, so a peer watching it reads a
// DOWN. An answer starts with the word it answers, so a peer reads the opcode first and parses what that opcode carries.
// Two of these facing each other would otherwise answer each other for ever, each term naming the other side: the same
// rule `robot.erl` keeps, and for the same reason.

import { defineActor, defineMessages } from "posipaki";

import type { EtfTerm } from "../src/node.js";
import { processTerm, show, type ErlangProcess, type VisibleTerm } from "../src/processes.js";
import { atom, binary, tuple } from "../src/terms.js";

/** The word a term carries: a binary is its own word, and `{Pid, Text}` is how a peer asks for an answer. */
function wordIn(body: VisibleTerm): string | null {
  if (body.kind === "binary") return body.bytes.toString("utf8");
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

/** Says what it was asked, and does what the word asks: answers the process the term names, or ends. */
export const Answerer = defineActor({
  name: "answerer",
  inMessages: defineMessages<EtfTerm>(),
  outMessages: defineMessages<never>(),
  methods: {
    /** Answers `hi`, with the pid this process answers at and the word it says back. */
    async hi(to: ErlangProcess): Promise<void> {
      await to.send(tuple(atom("hi"), processTerm(this.self), binary(Buffer.from("answering", "utf8"))));
    },
    /** Answers `whois` with the pid a peer monitors this process by. */
    async whois(to: ErlangProcess): Promise<void> {
      await to.send(tuple(atom("whois"), processTerm(this.self)));
    },
  },
  handlers: {
    async ETF_RAW(asked: EtfTerm) {
      console.log(`  asked: ${show(asked.body)}`);
      const word = wordIn(asked.body);
      if (word === null) {
        console.log("  and nothing to answer: the term carries no word");
        return;
      }
      // The word is the opcode of the answer: `exit` ends the process, and the others name a method of this actor.
      if (word === "exit") {
        console.log("  exit: this process ends, and a peer watching it is told why");
        this.exit("asked to");
        return;
      }
      if (word !== "hi" && word !== "whois") {
        console.log(`  and nothing here answers ${word}`);
        return;
      }
      const to = namedIn(asked.body);
      if (to === null) {
        console.log("  and nothing to answer: the term names no process");
        return;
      }
      await this[word](to);
    },
  },
});
