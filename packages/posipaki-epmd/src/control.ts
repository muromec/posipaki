// ── the control message ────────────────────────────────────────────────────
//
// A distribution message is a control tuple and, for some opcodes, the message after it. The tuple says what kind
// of signal this is — the numbers are erts' own, from the `dop` enum in erts/emulator/beam/dist.h — and its fields
// are pids, names and a reason.
//
// Six are this client's business: a message sent to a process of ours, the registered send this side writes, the exit a
// node closes a connection with, and the three a monitor is made of. Anything else is a signal for a node table this
// script does not keep, and it is named as other rather than silently skipped.

import { atom, integer, render, tuple, type Term } from "./terms.js";

const DOP_LINK = 1;
const DOP_SEND = 2;
const DOP_EXIT = 3;
const DOP_REG_SEND = 6;
const DOP_UNLINK = 4;
const DOP_MONITOR_P = 19;
const DOP_DEMONITOR_P = 20;
const DOP_MONITOR_P_EXIT = 21;

/** One control message, in the vocabulary of the opcode it carries. */
export type Control =
  /** `{DOP_SEND, '', To}`: a message for one process. */
  | { readonly kind: "send"; readonly to: Term }
  /** `{DOP_REG_SEND, From, '', ToName}`: a message for whatever is registered under a name. */
  | { readonly kind: "regSend"; readonly from: Term; readonly to: string }
  /** `{DOP_LINK, FromPid, ToPid}`: a peer linked itself to one of this node's processes. */
  | { readonly kind: "link"; readonly from: Term; readonly to: Term }
  /** `{DOP_UNLINK, FromPid, ToPid}`: the same two fields, and the link is over. */
  | { readonly kind: "unlink"; readonly from: Term; readonly to: Term }
  /** `{DOP_EXIT, From, To, Reason}`: a linked process ended, or `exit/2` was called on this one. */
  | { readonly kind: "exit"; readonly from: Term; readonly to: Term; readonly reason: Term }
  /** `{DOP_MONITOR_P, FromPid, ToProc, Ref}`: a peer watching one of this node's processes. `to` is a pid or a name. */
  | { readonly kind: "monitor"; readonly from: Term; readonly to: Term; readonly ref: Term }
  /** `{DOP_DEMONITOR_P, FromPid, ToProc, Ref}`: the same three fields, so the watch is cancelled by its ref. */
  | { readonly kind: "demonitor"; readonly from: Term; readonly to: Term; readonly ref: Term }
  /** `{DOP_MONITOR_P_EXIT, FromProc, ToPid, Ref, Reason}`: the watched thing ended, and this is why. */
  | { readonly kind: "monitorExit"; readonly from: Term; readonly to: Term; readonly ref: Term; readonly reason: Term }
  /** A signal this client does not act on, with the opcode it carried. */
  | { readonly kind: "other"; readonly opcode: number; readonly items: readonly Term[] };

/** A name out of a control message's field, which is an atom on this wire. */
function nameOf(value: Term | undefined, what: string): string {
  if (value === undefined || value.kind !== "atom") {
    throw new Error(`a control message named nothing where ${what} belonged: ${value?.kind ?? "no field"}`);
  }
  return value.name;
}

/** A field of a control tuple, or the empty atom a missing one reads as: a shape this side can then refuse by name. */
function field(term: Term, index: number): Term {
  return term.kind === "tuple" ? (term.items[index] ?? atom("")) : atom("");
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
      // {DOP_SEND, the empty atom, To}: the second field is the cookie slot, unread since R9B.
      return { kind: "send", to: field(term, 2) };
    case DOP_LINK:
      return { kind: "link", from: field(term, 1), to: field(term, 2) };
    case DOP_UNLINK:
      return { kind: "unlink", from: field(term, 1), to: field(term, 2) };
    case DOP_REG_SEND:
      return { kind: "regSend", from: field(term, 1), to: nameOf(term.items[3], "the name to send to") };
    case DOP_EXIT:
      return { kind: "exit", from: field(term, 1), to: field(term, 2), reason: field(term, 3) };
    case DOP_MONITOR_P:
      // {DOP_MONITOR_P, FromPid, ToProc, Ref}: ToProc is a pid or a name, and the ref is the watcher's own to echo.
      return { kind: "monitor", from: field(term, 1), to: field(term, 2), ref: field(term, 3) };
    case DOP_DEMONITOR_P:
      return { kind: "demonitor", from: field(term, 1), to: field(term, 2), ref: field(term, 3) };
    case DOP_MONITOR_P_EXIT:
      return {
        kind: "monitorExit",
        from: field(term, 1),
        to: field(term, 2),
        ref: field(term, 3),
        reason: field(term, 4),
      };
    default:
      return { kind: "other", opcode: head.value, items: term.items };
  }
}

/** The term of a control message this side sends. */
export function writeControl(control: Control): Term {
  switch (control.kind) {
    case "send":
      return tuple(integer(DOP_SEND), atom(""), control.to);
    case "regSend":
      // {DOP_REG_SEND, From, Cookie, ToName}: the cookie slot has been the empty atom since R9B and is not read.
      return tuple(integer(DOP_REG_SEND), control.from, atom(""), atom(control.to));
    case "link":
      return tuple(integer(DOP_LINK), control.from, control.to);
    case "unlink":
      return tuple(integer(DOP_UNLINK), control.from, control.to);
    case "exit":
      return tuple(integer(DOP_EXIT), control.from, control.to, control.reason);
    case "monitor":
      return tuple(integer(DOP_MONITOR_P), control.from, control.to, control.ref);
    case "demonitor":
      return tuple(integer(DOP_DEMONITOR_P), control.from, control.to, control.ref);
    case "monitorExit":
      // {DOP_MONITOR_P_EXIT, FromProc, ToPid, Ref, Reason}: what was watched, as it was asked for, and why it ended.
      return tuple(integer(DOP_MONITOR_P_EXIT), control.from, control.to, control.ref, control.reason);
    case "other":
      // A signal this client does not act on is not one it can write: its fields are the opcode's own.
      throw new Error(`a control message of opcode ${control.opcode} is not one this side writes`);
  }
}
