// ── the process a node is served by ─────────────────────────────────────────
// What a served process looks like from inside: it is handed a term, it prints what it carries, and it answers the
// process the term itself names — not the one that asked — which is what makes an answer from one node reach a second
// one. It never sees an address.
//
// A term starts with its opcode, an ask and an answer alike: `{whois, Pid}` asks and `{whois, Pid}` answers, and a bare
// binary is a word with nothing after it, so `exit` ends the process and a peer watching it reads a DOWN. The words this
// process answers are its methods, and `exit` is the one opcode that is not one. Two of these facing each other would
// otherwise answer each other for ever, each term naming the other side: the same rule `robot.erl` keeps, for the same
// reason.

import { defineActor, defineMessages } from "posipaki";

import type { EtfTerm } from "../src/node.js";
import { processTerm, show, type ErlangProcess, type VisibleTerm } from "../src/processes.js";
import { atom, binary, tuple } from "../src/terms.js";

/** The words this process answers, each a method. `exit` is not one: it ends the process instead of being answered. */
const ANSWERS = ["hi", "whois"] as const;

type Word = (typeof ANSWERS)[number];

/** Whether this process answers a word. The methods are the only list; this one has to name them to a string. */
function isAnswer(word: string): word is Word {
  return ANSWERS.some((known) => known === word);
}

/** What a term asks: the opcode it starts with, and the process it names after it. A binary is a word alone. */
function askIn(body: VisibleTerm): { word: string; to: ErlangProcess | null } | null {
  if (body.kind === "binary") return { word: body.bytes.toString("utf8"), to: null };
  if (body.kind !== "tuple") return null;
  const [word, named] = body.items;
  if (word?.kind !== "atom") return null;
  return { word: word.name, to: named?.kind === "remote" ? named.process : null };
}

/** Says what it was asked, and does what the opcode asks: answers the process the term names, or ends. */
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
      const ask = askIn(asked.body);
      if (ask === null) {
        console.log("  and nothing to answer: the term starts with no opcode");
        return;
      }
      const { word, to } = ask;
      if (word === "exit") {
        console.log("  exit: this process ends, and a peer watching it is told why");
        this.exit("asked to");
        return;
      }
      if (!isAnswer(word)) {
        console.log(`  and nothing here answers ${word}`);
        return;
      }
      if (to === null) {
        console.log("  and nothing to answer: the term names no process");
        return;
      }
      await this[word](to);
    },
  },
});
