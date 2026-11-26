// ── processes in a term ────────────────────────────────────────────────────
//
// The walk, in both directions: what an actor puts in a term, and what it is handed back. Nothing here talks to a
// node — the point is that a process is never an address a caller has to spell out.

import { beforeAll, describe, expect, it } from "vitest";
import { defineActor, defineMessages, type AnyProcess } from "posipaki";

import { nodeRef } from "./cluster.js";
import {
  forHere,
  forWire,
  processAt,
  processNamed,
  processTerm,
  remoteTerm,
  show,
  type ErlangProcess,
  type PidTerm,
  type Reach,
} from "./processes.js";
import { atom, binary, list, map, pid, tuple } from "./terms.js";

/** A process of this side, so a term can carry one and a case can say who is sending. */
const Sender = defineActor({
  name: "sender",
  inMessages: defineMessages<never>(),
  outMessages: defineMessages<never>(),
  handlers: {},
});

/** The caller: a real process, because a term carries nothing else. Spawned before the cases, not at import. */
let CLI: AnyProcess;
beforeAll(async () => {
  CLI = await Sender.spawn(undefined);
});
const OURS_PID: PidTerm = pid("probe@192.168.88.27", 1, 0, 7);
const PEER_PID: PidTerm = pid("robot@192.168.88.20", 91, 0, 5);

/** A pid for a process, which is all a walk needs to be visible. */
const pidOf = (process: AnyProcess): PidTerm => ({ ...OURS_PID, id: process.id === CLI.id ? 1 : 2 });

/** A process on the node, as a caller would be handed one. */
const peer = (address: PidTerm): ErlangProcess => ({
  address: { kind: "pid", pid: address },
  send: async () => undefined,
  monitor: () => new Promise(() => undefined),
  kill: async () => undefined,
  link: async () => undefined,
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
    here: (address: PidTerm): AnyProcess | null => (address.node === OURS_PID.node ? CLI : null),
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
    expect(show(tuple(processTerm(CLI), atom("hi")))).toBe("{#process<sender>, hi}");
    expect(show(tuple(remoteTerm(peer(PEER_PID))))).toBe("{#remote<robot@192.168.88.20.91>}");
  });
});

describe("a process of another node", () => {
  /** A node that records the verbs a handle asks it for. */
  function recording() {
    const called: string[] = [];
    const reach: Reach = {
      pidOf: () => OURS_PID,
      processOf: () => null,
      send: async () => {
        called.push("send");
      },
      sendReg: async () => {
        called.push("sendReg");
      },
      watch: () => new Promise(() => undefined),
      watchName: () => new Promise(() => undefined),
      kill: async () => {
        called.push("kill");
      },
      link: async () => {
        called.push("link");
      },
      spawn: async () => {
        throw new Error("this double starts nothing");
      },
    };
    return { reach, called };
  }

  it("sends to a pid with no sender, and to a name only when one is given", async () => {
    const { reach, called } = recording();
    // A process of this side that sends: `send` and `link` take one, and a bare handle is not a process.
    const sender = await Sender.spawn(undefined);
    await processAt(PEER_PID, reach).send(atom("hi"));
    expect(called).toEqual(["send"]);

    // `{6, From, '', Name}` carries a sender, and a reference carries no process: the caller says who is sending.
    const named = processNamed(nodeRef("robot", "192.168.88.20"), "relay", reach);
    await expect(named.send(atom("hi"))).rejects.toThrow("must say who sent it");
    await named.send(atom("hi"), sender);
    expect(called).toEqual(["send", "sendReg"]);
  });

  it("exits and links a pid, and refuses to do either to a name", async () => {
    const { reach, called } = recording();
    await processAt(PEER_PID, reach).kill();
    const sender = await Sender.spawn(undefined);
    await processAt(PEER_PID, reach).link(sender);
    expect(called).toEqual(["kill", "link"]);

    // `{3, …}` and `{1, …}` carry addresses, and a name is not one.
    const named = processNamed(nodeRef("robot", "192.168.88.20"), "relay", reach);
    await expect(named.kill()).rejects.toThrow("a name cannot be exited");
    await expect(named.link(sender)).rejects.toThrow("a name cannot be linked");
  });

  it("is a name when it was found by one, and a name has no place in a term", () => {
    const { reach } = recording();
    const named = processNamed(nodeRef("robot", "192.168.88.20"), "relay", reach);
    expect(() => forWire(tuple(remoteTerm(named)), pidOf)).toThrow("a term carries addresses");
  });
});
