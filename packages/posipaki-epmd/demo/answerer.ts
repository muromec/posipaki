// ── the process a node is served by ─────────────────────────────────────────
// What a served process looks like from inside: it is handed a term, it prints what it carries, and it answers the
// process the term itself names — not the one that asked — which is what makes an answer from one node reach a second
// one. It never sees an address.
//
// A term starts with its opcode, an ask and an answer alike: `{whois, Pid}` asks and `{whois, Pid}` answers, and a bare
// binary is an opcode with nothing after it, so `exit` ends the process and a peer watching it reads a DOWN. The
// opcodes this process answers are its methods, and `exit` is the one that is not one. Two of these facing each other
// would otherwise answer each other for ever, each term naming the other side: the same rule `robot.erl` keeps.

import { defineActor, defineMessages } from "posipaki";

import type { EtfTerm } from "../src/node.js";
import { processTerm, show, type ErlangProcess, type VisibleTerm } from "../src/processes.js";
import { atom, binary, tuple } from "../src/terms.js";

/** The three messages a served process answers: the opcode a term starts with, and what that opcode carries. */
type Ask =
  | { opcode: "hi"; from: ErlangProcess }
  | { opcode: "whois"; from: ErlangProcess }
  | { opcode: "exit" };

/** The ask a term carries, or nothing when it carries one of the other three. */
function askIn(body: VisibleTerm): Ask | null {
  if (body.kind === "binary") return body.bytes.toString("utf8") === "exit" ? { opcode: "exit" } : null;
  if (body.kind !== "tuple") return null;
  const [opcode, from] = body.items;
  if (opcode?.kind !== "atom" || from?.kind !== "remote") return null;
  if (opcode.name !== "hi" && opcode.name !== "whois") return null;
  return { opcode: opcode.name, from: from.process };
}

/** Says what it was asked, and does what the opcode asks: answers the process the term names, or ends. */
export const Answerer = defineActor({
  name: "answerer",
  inMessages: defineMessages<EtfTerm>(),
  outMessages: defineMessages<never>(),
  methods: {
    /** Answers `hi`, with the pid this process answers at and what it says back. */
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
        console.log("  and nothing here answers that term");
        return;
      }
      if (ask.opcode === "exit") {
        console.log("  exit: this process ends, and a peer watching it is told why");
        this.exit("asked to");
        return;
      }
      await this[ask.opcode](ask.from);
    },
  },
});
