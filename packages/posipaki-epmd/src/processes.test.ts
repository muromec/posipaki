// ── processes in a term ────────────────────────────────────────────────────
//
// The walk, in both directions: what an actor puts in a term, and what it is handed back. Nothing here talks to a
// node — the point is that a process is never an address a caller has to spell out.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineActor, defineMessages, type AnyProcess } from "posipaki";

import { makeCluster, nodeRef } from "./cluster.js";
import { startNode, type ErlangNode } from "./node.js";
import {
  forHere,
  forWire,
  processAt,
  processNamed,
  processTerm,
  senderPidOf,
  remoteTerm,
  show,
  type ErlangProcess,
  type PidTerm,
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

/** Every node a case started: each is closed in its own teardown so the next case starts from nothing. */
const opened: ErlangNode[] = [];

afterEach(async () => {
  for (const erlang of opened.splice(0)) await erlang.close().catch(() => undefined);
});
const OURS_PID: PidTerm = pid("probe@192.168.88.27", 1, 0, 7);
const PEER_PID: PidTerm = pid("robot@192.168.88.20", 91, 0, 5);

/** A pid for a process, which is all a walk needs to be visible. */
const pidOf = (process: AnyProcess): PidTerm => ({ ...OURS_PID, id: process.id === CLI.id ? 1 : 2 });

/** A process on the node, as a caller would be handed one. */
const peer = (address: PidTerm): ErlangProcess => ({
  pid: address,
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
  /** A real node, with the verbs a handle asks it for spied on: what is measured is what the handle chose to call. */
  async function recording() {
    const called: string[] = [];
    const erlang = await startNode({
      clusterName: "test",
      self: "probe@192.168.88.27",
      cookie: "probe",
      register: false,
      host: "127.0.0.1",
      port: 0,
    });
    for (const verb of ["send", "sendReg", "kill", "link"] as const) {
      vi.spyOn(erlang, verb).mockImplementation(async () => {
        called.push(verb);
      });
    }
    vi.spyOn(erlang, "watch").mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(erlang, "watchName").mockImplementation(() => new Promise(() => undefined));
    opened.push(erlang);
    return { erlang, called };
  }

  it("sends to a pid with no sender, and to a name with one", async () => {
    const { erlang, called } = await recording();
    // `{2, '', To}` has no sender field, so a process is written to without one.
    await processAt(PEER_PID, erlang).send(atom("hi"));
    expect(called).toEqual(["send"]);

    // `{6, From, '', Name}` carries a sender, and the caller says who is sending.
    const sender = await Sender.spawn(undefined);
    const named = processNamed(nodeRef("robot", "192.168.88.20"), "relay", erlang);
    await named.send(atom("hi"), sender);
    expect(called).toEqual(["send", "sendReg"]);
  });

  it("exits and links a pid, and a name has neither verb", async () => {
    const { erlang, called } = await recording();
    await processAt(PEER_PID, erlang).kill();
    const sender = await Sender.spawn(undefined);
    await processAt(PEER_PID, erlang).link(sender);
    expect(called).toEqual(["kill", "link"]);

    // `{3, …}` and `{1, …}` carry pids, so a name has no pid to be exited or linked by: there is nothing to refuse at
    // runtime, and no such method on the type.
    const named = processNamed(nodeRef("robot", "192.168.88.20"), "relay", erlang);
    expect(Object.keys(named).sort()).toEqual(["monitor", "name", "ref", "send"]);
  });

  it("writes a sender as a pid: one over there as it stands, a process of this side minted", async () => {
    const { erlang } = await recording();
    expect(senderPidOf(processAt(PEER_PID, erlang), pidOf)).toEqual(PEER_PID);

    const sender = await Sender.spawn(undefined);
    expect(senderPidOf(sender, pidOf)).toEqual({ ...OURS_PID, id: 2 });
  });
});
