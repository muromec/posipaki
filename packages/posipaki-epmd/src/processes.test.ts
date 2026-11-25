// ── processes in a term ────────────────────────────────────────────────────
//
// The walk, in both directions: what an actor puts in a term, and what it is handed back. Nothing here talks to a
// node — the point is that a process is never an address a caller has to spell out.

import { describe, expect, it } from "vitest";

import type { ProcessHandle } from "./cluster.js";
import { forHere, forWire, processTerm, remoteTerm, show, type PidTerm, type RemoteProcess } from "./processes.js";
import { atom, binary, list, map, pid, tuple } from "./terms.js";

const CLI: ProcessHandle = { pname: "root:cli", id: Symbol("cli") };
const OURS_PID: PidTerm = pid("probe@192.168.88.27", 1, 0, 7);
const PEER_PID: PidTerm = pid("robot@192.168.88.20", 91, 0, 5);

/** A pid for a handle, which is all a walk needs to be visible. */
const pidOf = (handle: ProcessHandle): PidTerm => ({ ...OURS_PID, id: handle.id === CLI.id ? 1 : 2 });

/** A process on the node, as a caller would be handed one. */
const peer = (address: PidTerm): RemoteProcess => ({
  pid: address,
  send: async () => undefined,
  // A walk never asks a process to wait; the double only has to exist.
  wait: () => new Promise(() => undefined),
});

describe("forWire", () => {
  it("replaces a process with the address it was given, at any depth", () => {
    const one = pidOf(CLI);
    const term = tuple(processTerm(CLI), list(atom("hi"), processTerm(CLI)), map([atom("who"), processTerm(CLI)]));
    expect(forWire(term, pidOf)).toEqual(tuple(one, list(atom("hi"), one), map([atom("who"), one])));
  });

  it("writes a remote process as the pid it arrived with", () => {
    expect(forWire(tuple(remoteTerm(peer(PEER_PID))), pidOf)).toEqual(tuple(PEER_PID));
  });
});

describe("forHere", () => {
  const readers = {
    here: (address: PidTerm): ProcessHandle | null => (address.node === OURS_PID.node ? CLI : null),
    there: peer,
  };

  it("reads our own pid back as the process it names", () => {
    expect(forHere(tuple(OURS_PID, binary(Buffer.from("hi"))), readers)).toEqual(
      tuple(processTerm(CLI), binary(Buffer.from("hi"))),
    );
  });

  it("reads the node's pid as a remote process, which is how a caller gets one", () => {
    const read = forHere(tuple(atom("hi"), PEER_PID), readers);
    expect(read.kind).toBe("tuple");
    if (read.kind !== "tuple") return;
    expect(read.items[1]?.kind).toBe("remote");
  });
});

describe("show", () => {
  it("names a process as what it is rather than as an address", () => {
    expect(show(tuple(processTerm(CLI), atom("hi")))).toBe("{#process<root:cli>, hi}");
    expect(show(tuple(remoteTerm(peer(PEER_PID))))).toBe("{#remote<robot@192.168.88.20.91>}");
  });
});
