// ── the control message ────────────────────────────────────────────────────
//
// A distribution message is a control tuple and, for some opcodes, the message after it. The tuple says what kind
// of signal this is — the numbers are erts' own, from the `dop` enum in erts/emulator/beam/dist.h — and its fields
// are pids, names and a reason.
//
// Three are this client's business: a message sent to a process of ours, the registered send this side writes, and
// the exit a node closes a connection with. Anything else is a signal for a node table this script does not keep,
// and it is named as other rather than silently skipped.

import { render, type Term } from "./terms.js";

const DOP_SEND = 2;
const DOP_EXIT = 3;
const DOP_REG_SEND = 6;

/** One control message, in the vocabulary of the opcode it carries. */
export type Control =
  /** `{DOP_SEND, '', To}`: a message for one process. */
  | { readonly kind: "send"; readonly to: Term }
  /** `{DOP_REG_SEND, From, '', ToName}`: a message for whatever is registered under a name. */
  | { readonly kind: "regSend"; readonly from: Term; readonly to: string }
  /** `{DOP_EXIT, From, To, Reason}`: the node is closing the connection. */
  | { readonly kind: "exit"; readonly from: Term; readonly to: Term; readonly reason: Term }
  /** A signal this client does not act on, with the opcode it carried. */
  | { readonly kind: "other"; readonly opcode: number; readonly items: readonly Term[] };

/** A name out of a control message's field, which is an atom on this wire. */
function nameOf(field: Term | undefined, what: string): string {
  if (field === undefined || field.kind !== "atom") {
    throw new Error(`a control message named nothing where ${what} belonged: ${field?.kind ?? "no field"}`);
  }
  return field.name;
}

/** Reads a control message, or says which shape it had instead of a shape this wire knows. */
export function readControl(term: Term): Control {
  if (term.kind !== "tuple" || term.items.length === 0) {
    const what = term.kind === "tuple" ? "an empty tuple" : render(term);
    throw new Error(`a control message was ${what}, not a tuple headed by an opcode`);
  }
  const head = term.items[0];
  if (head === undefined || head.kind !== "int") {
    throw new Error(`a control message began with ${head?.kind ?? "nothing"}, not an opcode`);
  }
  switch (head.value) {
    case DOP_SEND:
      // {DOP_SEND, '', To}: the second field is the cookie slot, which erts has not read since R9B.
      return { kind: "send", to: term.items[2] ?? { kind: "atom", name: "" } };
    case DOP_REG_SEND:
      return { kind: "regSend", from: term.items[1] ?? { kind: "atom", name: "" }, to: nameOf(term.items[3], "the name to send to") };
    case DOP_EXIT:
      return {
        kind: "exit",
        from: term.items[1] ?? { kind: "atom", name: "" },
        to: term.items[2] ?? { kind: "atom", name: "" },
        reason: term.items[3] ?? { kind: "atom", name: "" },
      };
    default:
      return { kind: "other", opcode: head.value, items: term.items };
  }
}

/** The term of a control message this side sends. */
export function writeControl(control: Control): Term {
  switch (control.kind) {
    case "send":
      return { kind: "tuple", items: [{ kind: "int", value: DOP_SEND }, { kind: "atom", name: "" }, control.to] };
    case "regSend":
      return {
        kind: "tuple",
        items: [
          { kind: "int", value: DOP_REG_SEND },
          control.from,
          { kind: "atom", name: "" },
          { kind: "atom", name: control.to },
        ],
      };
    case "exit":
      return {
        kind: "tuple",
        items: [
          { kind: "int", value: DOP_EXIT },
          control.from,
          control.to,
          control.reason,
        ],
      };
    case "other":
      // A signal this client does not act on is not one it can write: its fields are the opcode's own.
      throw new Error(`a control message of opcode ${control.opcode} is not one this side writes`);
  }
}
