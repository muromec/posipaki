// ── a node: what this side serves, and what it reaches ──────────────────────
//
// One module, both directions. A peer reaches the processes served here: a listener, the registration that makes it
// findable in a mapper, and a table from a name and a pid to a process. This side reaches a peer: a connection per node,
// the pids it answers at, the watches it sets and the starts it asks for.
//
// It is not a process. Nothing waits in a mailbox for a frame — a connection is read where its frames arrive — and a
// served process is an ordinary actor: it hears one term as an in-message, `{from, body}`, and answers with one
// out-message, `{to, body}`.
//
// The tables are the whole of the routing: a name a node sends to, and a pid this node minted for a process. A pid for a
// process it does not serve names nobody here, however well this node knows it.

import type { AnyProcess, Message } from "posipaki";
import type { Channel } from "posipaki/port";
import { socketChannel } from "posipaki/port/node";

import {
  DEFAULT_CLUSTER,
  nodeName,
  refFromName,
  refOf,
  type Cluster,
  type NodeRef,
  type PidTerm,
  type ProcessHandle,
  type Watch,
} from "./cluster.js";
import { open } from "./connection.js";
import type { Control } from "./control.js";
import {
  epmdPort,
  epmdRegister,
  mapperAnswers,
  MapperPortTaken,
  serveEpmd,
  type Mapper,
  type Registration,
} from "./epmd.js";
import { DEFAULT_TIMEOUT_MS, type Peer } from "./handshake.js";
import { listen, type Listener } from "./listen.js";
import type { WireMessage } from "./messages.js";
import {
  forHere,
  forWire,
  processAt,
  senderPidOf,
  type ErlangProcess,
  type Reach,
  type Start,
  type TermSender,
  type VisibleTerm,
} from "./processes.js";
import { atom, binary, integer, list, reference, render, tuple, type Term } from "./terms.js";
import { withTimeout } from "./timeout.js";

/** A term from another node. What a term says about where its answer goes is in the term. */
export interface EtfAsked {
  type: "ETF_RAW";
  body: VisibleTerm;
}

/** A term to a process, as a served process answers. */
export interface EtfAnswered {
  type: "ETF_RAW";
  to: ErlangProcess;
  body: VisibleTerm;
}

/** A watch a peer set on a process of this node, until the process ends or the peer cancels it. */
interface PeerWatch {
  /** The address the peer used: a pid, or a name. The answer carries this, not the pid it resolved to. */
  readonly asked: Term;
  /** The pid that asked, which is where the answer goes. */
  readonly watcher: Term;
  /** The reference the peer minted for this watch, echoed back unchanged. */
  readonly ref: Term;
  readonly process: AnyProcess;
  /** The connection the watch came in on: the answer goes back the way it was asked for. */
  readonly messages: Channel<WireMessage>;
}

/** How a node tells a mapper where it listens, or `false` for a node nobody can look up. */
export type Announce = ((port: number) => Promise<Registration>) | false;

/** A connection as this file needs it: the way to a node, and which incarnation answered. */
interface Reached {
  readonly messages: Channel<WireMessage>;
  readonly peer: Peer;
}

/** The port of the mapper on every host this protocol talks to. */
const EPMD_PORT = 4369;

export interface NodeOptions {
  /** The port to listen on. Default 0: the OS picks one, and the handle answers it. */
  readonly port?: number;
  /** The interface to bind. Default `0.0.0.0` — a node bound to loopback is reachable from this host only. */
  readonly host?: string;
}

/** A node this side runs: what it answers to, where it listens, and the processes it serves. */
export interface ErlangNode {
  /** The name it answers to on the wire, `name@host`. */
  readonly name: string;
  /** Links a process this node serves to one on another node: whichever ends first takes the other with it. */
  link(from: PidTerm, to: PidTerm): Promise<void>;
  /** Ends a link this side set. The peer is told, and neither end is owed anything after it. */
  unlink(from: PidTerm, to: PidTerm): Promise<void>;
  readonly port: number;
  /** Registers a process under a name: what another node addresses it by. A name already held is refused. */
  registerProcess(name: string, process: AnyProcess): void;
  /** Serves the processes on a connection whose frames nobody else reads — one this side opened. */
  attach(messages: Channel<WireMessage>): void;
  /** The channel to one node, opened on first use and shared by everything that addresses it. */
  channel(ref: NodeRef): Promise<Channel<WireMessage>>;
  /** One term to a process of another node. `{2, '', To}` carries no sender. */
  send(pid: PidTerm, body: Term): Promise<void>;
  /** One term to a registered name. `{6, From, '', Name}` carries the sender, so one is needed. */
  sendReg(name: string, ref: NodeRef, body: Term, from: TermSender): Promise<void>;
  /** Watches a process of another node: what settles with the reason it ended. */
  watch(pid: PidTerm): Promise<Watch>;
  /** The same watch, where the other node knows the process by a registered name. */
  watchName(ref: NodeRef, name: string): Promise<Watch>;
  /** Ends a process of another node with `kill`. `{3, From, To, kill}` carries a sender, and this node mints one. */
  kill(pid: PidTerm): Promise<void>;
  /** Asks a node to start `module:function(args)` and answers a handle to the process. */
  spawn(ref: NodeRef, call: Start): Promise<ErlangProcess>;
  /** Asks a node to run `module:function(args)` and answers what it answered: an RPC over the node's own server. */
  rpc(ref: NodeRef, call: Start): Promise<VisibleTerm>;
  /**
   * The pid this node answers at for a process: minted once for its lifetime, and served by the same call.
   *
   * Serving it is what makes the address mean something: a pid this node wrote for a process nothing routes to would
   * promise more than it keeps.
   */
  pidOf(process: AnyProcess): PidTerm;
  /** The process a pid names here, or null for a pid this node does not serve. */
  processOf(pid: PidTerm): AnyProcess | null;
  close(): Promise<void>;
}

/** Starts a node: listens, announces itself where it is told, serves what `serve` is given, and reaches the rest. */
export async function startNode(cluster: Cluster, options: NodeOptions = {}): Promise<ErlangNode> {
  // One node per name: two of them would mint the same pids and answer for each other's processes.
  if (running.has(cluster.name)) throw new Error(`the cluster ${cluster.name} already runs a node`);

  const byName = new Map<string, AnyProcess>();
  const byId = new Map<symbol, AnyProcess>();
  /** How to stop watching each served process's out-messages, by the process's own id. */
  const leaving = new Map<symbol, () => void>();
  /** How to stop reading each connection's frames. */
  const reading = new Map<Channel<WireMessage>, () => void>();

  /** The peers each of this node's processes is linked to, by the process's own id. */
  const linked = new Map<symbol, Set<PidTerm>>();
  /** Records a link a peer made to a process here, or one this side made to a peer.'s. */
  const linkTo = (process: AnyProcess, peer: PidTerm): void => {
    const known = linked.get(process.id) ?? new Set<PidTerm>();
    known.add(peer);
    linked.set(process.id, known);
  };

  /** Forgets one link. Both ends are told when one of them ends, so a link ends once. */
  const unlinkFrom = (process: AnyProcess, peer: PidTerm): void => {
    linked.get(process.id)?.delete(peer);
  };

  /** Sends a control message about a process of this node over the wire that reaches a peer.'s pid. */
  const controlTo = async (pid: PidTerm, said: Control): Promise<void> => {
    const messages = await channel(refOf(pid, cluster.name));
    await messages.send({ kind: "message", control: said, payload: null });
  };

  /** The pid this node answers at for a process it serves. */
  const pidFor = (process: AnyProcess): PidTerm => pidOf(process);

  /** Watches a peer set, by the octets of the ref it minted: one table, walked when a process ends. */
  const watches = new Map<string, PeerWatch>();
  /** The answers on their way out: `close` lets them finish before the connections they go over are let go. */
  const sending = new Set<Promise<void>>();

  /** The process a pid names, when this node serves it. A pid of a process it does not serve names nobody here. */
  const byPid = (address: Term): AnyProcess | null => {
    if (address.kind !== "pid") return null;
    const holder = holderOf(address);
    return holder === null ? null : (byId.get(holder.id) ?? null);
  };

  /** One answer to a watch, addressed as the peer asked it: what it watched, the pid that asked, and the ref. */
  const answerWatch = (messages: Channel<WireMessage>, asked: Term, watcher: Term, ref: Term, reason: Term): void => {
    const sent = messages
      .send({
        kind: "message",
        control: { kind: "monitorExit", from: asked, to: watcher, ref, reason },
        payload: null,
      })
      .catch((error: unknown) => {
        // The wire went first: the peer is not there to be told, and a second complaint about it is noise.
        console.error(
          `erlang-node: ${cluster.self} could not say why a process ended: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    sending.add(sent);
    void sent.finally(() => sending.delete(sent));
  };

  /** Records a watch a peer set, or answers `noproc` when the address names nobody here. */
  const startWatch = (messages: Channel<WireMessage>, from: Term, to: Term, ref: Term): void => {
    if (ref.kind !== "ref" || from.kind !== "pid") {
      console.error(`erlang-node: ${cluster.self} was asked to watch without a ref to answer by: ${render(ref)}`);
      return;
    }
    const process = to.kind === "atom" ? (byName.get(to.name) ?? null) : byPid(to);
    if (process === null) {
      // An address nobody answers is a watch that ends at once: erts says `noproc` rather than leaving it open.
      answerWatch(messages, to, from, ref, atom("noproc"));
      return;
    }
    watches.set(ref.bytes.toString("hex"), { asked: to, watcher: from, ref, process, messages });
  };

  /** Forgets a watch the peer cancelled. Its ref is the whole of the key, so nothing else has to be named. */
  const stopWatch = (ref: Term): void => {
    if (ref.kind === "ref") watches.delete(ref.bytes.toString("hex"));
  };

  /** Tells every peer watching `process`, in the words the wire uses for it, that the process is over. */
  const answerEnded = (process: AnyProcess, reason: Term): void => {
    for (const [key, watch] of watches) {
      if (watch.process !== process) continue;
      watches.delete(key);
      answerWatch(watch.messages, watch.asked, watch.watcher, watch.ref, reason);
    }
  };
  /** Says why a process of this node is over: to every watch it had, and down every link it was part of. */
  const ended = (process: AnyProcess, reason: Term): void => {
    answerEnded(process, reason);
    for (const peer of linked.get(process.id) ?? []) {
      void controlTo(peer, { kind: "exit", from: pidFor(process), to: peer, reason }).catch(() => undefined);
    }
    linked.delete(process.id);
  };

  /** What a peer says, read on the connection it said it on: a message goes to the process it names, a watch is kept. */
  const deliveredOn = (messages: Channel<WireMessage>) => (said: WireMessage): void => {
    if (said.kind !== "message") return;
    const control = said.control;
    if (control.kind === "monitor") {
      startWatch(messages, control.from, control.to, control.ref);
      return;
    }
    if (control.kind === "demonitor") {
      stopWatch(control.ref);
      return;
    }
    if (control.kind === "link") {
      const process = byPid(control.to);
      if (process !== null && control.from.kind === "pid") linkTo(process, control.from);
      return;
    }
    if (control.kind === "unlink") {
      const process = byPid(control.to);
      if (process !== null && control.from.kind === "pid") unlinkFrom(process, control.from);
      return;
    }
    if (control.kind === "exit") {
      // A link ends both ends. A normal exit ends nothing, which is what makes a link survivable.
      if (control.reason.kind === "atom" && control.reason.name === "normal") return;
      const process = byPid(control.to);
      if (process === null) {
        console.error(`erlang-node: ${cluster.self} was told a linked process ended, and serves no ${render(control.to)}`);
        return;
      }
      void process.stop();
      return;
    }
    if (control.kind !== "send" && control.kind !== "regSend") return;

    const process = control.kind === "regSend" ? (byName.get(control.to) ?? null) : byPid(control.to);
    if (process === null) {
      // A pid minted for a question is served by nothing: the RPC answer is read here, not delivered to a process.
      const waiter = control.kind === "send" && control.to.kind === "pid" ? asking.get(control.to.id) : undefined;
      if (waiter !== undefined && control.kind === "send" && control.to.kind === "pid") {
        asking.delete(control.to.id);
        waiter.settle(said.payload ?? atom(""));
        return;
      }
      // erts drops a message for a name nobody answers without a word. This side says it once and keeps the
      // connection: another node's bookkeeping is not a reason to fail a wire.
      console.error(`erlang-node: ${cluster.self} was addressed ${described(control)}, which serves nobody here`);
      return;
    }

    const asked: EtfAsked = {
      type: "ETF_RAW",
      body: forHere(said.payload ?? atom(""), {
        here: (pid) => reach.processOf(pid),
        there: (pid) => processAt(pid, reach),
      }),
    };
    void process.send(asked);
  };

  const attach = (messages: Channel<WireMessage>): void => {
    if (reading.has(messages)) return;
    reading.set(messages, messages.onFrame(deliveredOn(messages)));
    messages.onClose(() => {
      reading.delete(messages);
      // Nothing is owed to a watcher that is no longer there: a watch goes with the wire it came in on.
      for (const [key, watch] of watches) {
        if (watch.messages === messages) watches.delete(key);
      }
    });
  };

  const forget = (process: AnyProcess): void => {
    for (const [name, served] of byName) {
      if (served.id === process.id) byName.delete(name);
    }
    byId.delete(process.id);
    leaving.get(process.id)?.();
    leaving.delete(process.id);
  };

  /** Serves a process at its pid: the table a `{2}` resolves against. Idempotent. */
  const serve = (process: AnyProcess): void => {
    if (byId.has(process.id)) return;
    byId.set(process.id, process);
    leaving.set(
      process.id,
      process.subscribe("message", (message) => {
        if (message.type === "EXIT") {
          forget(process);
          return;
        }
        if (!isAnswer(message)) return;
        void message.to.send(message.body);
      }),
    );
    // A process ends twice: the EXIT lets go of its name, and the promise says why. A crash leaves its error on that
    // promise and nowhere else, so the watch is answered from there — after the name is gone, which the answer does not
    // need: it carries the address the peer asked with.
    void process.wait().then(
      () => ended(process, atom("normal")),
      (failure: unknown) => ended(process, failureTerm(failure)),
    );
  };

  /** Registers a process under a name: what a `{6}` resolves against. A name already held by another is refused. */
  const registerProcess = (name: string, process: AnyProcess): void => {
    const known = byName.get(name);
    if (known !== undefined && known.id !== process.id) {
      throw new Error(`${cluster.self} already serves ${name} with ${known.pname}`);
    }
    byName.set(name, process);
    pidOf(process);
  };

  // ── reaching another node ────────────────────────────────────────────────
  //
  // A node of another runtime is named, never held: a reference turns into a connection the first time it is used, and
  // what this side remembers about a peer is that table and nothing else.

  /** What asks a node where it listens: the cluster's own answer, or the mapper at its host. */
  const locate =
    cluster.locate ??
    (async (ref: NodeRef): Promise<number> => {
      return epmdPort(await socketChannel({ host: ref.host, port: EPMD_PORT }), { host: ref.host, name: ref.node });
    });

  /** The mapper this runtime started for its own host, when the policy said to: it is this process's to close. */
  let ownMapper: Mapper | null = null;

  /**
   * The registration that makes this node reachable: the mapper at its host, started here when the policy allows it.
   *
   * A port already taken is read as another mapper answering at it. The bind is a race, and on a host where several
   * processes come and go, losing it is the normal case.
   */
  const joinMapper = async (ref: NodeRef, port: number): Promise<Registration> => {
    const mapperPort = cluster.epmd?.port ?? EPMD_PORT;
    if (cluster.epmd?.start === "auto" && !(await mapperAnswers(ref.host, mapperPort))) {
      try {
        ownMapper = await serveEpmd(mapperPort);
      } catch (error) {
        // Another process took the port between the probe and this bind: its mapper answers, so the registration goes
        // there instead of this node failing to start.
        if (!(error instanceof MapperPortTaken)) throw error;
      }
    }
    return epmdRegister({ host: ref.host, name: ref.node, port, mapperPort });
  };

  /** How this node tells a mapper where it listens, or `false` for a node nobody can look up. */
  const tell: ((ref: NodeRef, port: number) => Promise<Registration>) | null =
    cluster.announce === false ? null : (cluster.announce ?? joinMapper);
  const announce: Announce =
    tell === null ? false : async (port: number) => tell(refFromName(cluster.self, cluster.name), port);

  /** The connections to other nodes, by the name the wire knows a node by: opened on first use, then shared. */
  const reached = new Map<string, Promise<Reached>>();
  const dialled = new Set<Channel<WireMessage>>();


  /** The connection to one node, opened on first use and shared by everything that addresses it. */
  const connection = (ref: NodeRef): Promise<Reached> => {
    const key = nodeName(ref);
    const known = reached.get(key);
    if (known !== undefined) return known;
    if (key === cluster.self) {
      return Promise.reject(new Error(`${key} is this side's own name: a pid on it is not sent over a wire`));
    }
    const made = (async () => {
      const port = await locate(ref);
      const opened = await open(port, {
        host: ref.host,
        node: ref.node,
        cookie: cluster.cookie,
        self: cluster.self,
        creation: cluster.creation,
        ...(cluster.flags === undefined ? {} : { flags: cluster.flags }),
        ...(cluster.timeoutMs === undefined ? {} : { timeoutMs: cluster.timeoutMs }),
      });
      opened.messages.onFrame(readsAnswers);
      opened.messages.onClose(() => {
        reached.delete(key);
        settleOver(opened.messages, atom("noconnection"));
        startFailed(opened.messages, new Error("the connection went before the node answered"));
      });
      // A connection this side opened is read as this node too: a peer answers on it, not on a second one.
      attach(opened.messages);
      dialled.add(opened.messages);
      return { messages: opened.messages, peer: opened.peer };
    })();
    const guarded = made.catch((error: unknown) => {
      reached.delete(key);
      throw error;
    });
    reached.set(key, guarded);
    return guarded;
  };

  /** The channel to one node, which is what everything above the wire takes. */
  const channel = async (ref: NodeRef): Promise<Channel<WireMessage>> => (await connection(ref)).messages;

  /** One term to a process of another node. `{2, '', To}` carries no sender, so a stale incarnation is all to refuse. */
  const sendTo = async (pid: PidTerm, payload: Term): Promise<void> => {
    const where = await connection(refOf(pid, cluster.name));
    if (where.peer.creation !== pid.creation) {
      throw new Error(
        `${pid.node} answers as incarnation ${where.peer.creation}, and this pid was minted by ${pid.creation}: ` +
          "the message is for a node that is not there any more",
      );
    }
    await where.messages.send({ kind: "message", control: { kind: "send", to: pid }, payload });
  };

  let nextId = 1;
  /** The pid each process answers at, by the symbol the framework gave it, and who each pid names. */
  const pids = new Map<symbol, PidTerm>();
  const owners = new Map<number, ProcessHandle>();

  /** Mints an address for a handle, remembered once: what a watcher or a sender of this side writes on the wire. */
  const addressFor = (handle: ProcessHandle): PidTerm => {
    const known = pids.get(handle.id);
    if (known !== undefined) return known;
    const minted: PidTerm = { kind: "pid", node: cluster.self, id: nextId++, serial: 0, creation: cluster.creation };
    pids.set(handle.id, minted);
    owners.set(minted.id, handle);
    return minted;
  };

  /**
   * The pid this node answers at for a process: minted once, and the address a peer that holds it sends to.
   *
   * Minting is the whole of it: a pid this node wrote for a process nothing can route a term to would promise more than
   * it keeps, so the same call is the one that serves the process.
   */
  const pidOf = (process: AnyProcess): PidTerm => {
    serve(process);
    return addressFor(process);
  };

  /** The process a pid of this node names, or null for a pid of another node or another incarnation. */
  const holderOf = (pid: PidTerm): ProcessHandle | null => {
    if (pid.node !== cluster.self || pid.creation !== cluster.creation) return null;
    return owners.get(pid.id) ?? null;
  };

  /** The watches this side set, by the octets of the ref it minted, with the connection each went over. */
  const watching = new Map<string, { resolve: (reason: Term) => void; messages: Channel<WireMessage> }>();
  let nextRef = 1;

  /** The answers awaited from a node's RPC server, by the pid minted for the question and the connection it went over. */
  const asking = new Map<number, { settle: (answer: Term | null) => void; messages: Channel<WireMessage> }>();

  /** Settles every watch that went over a connection: a peer that is gone answers nothing. */
  const settleOver = (messages: Channel<WireMessage>, reason: Term): void => {
    for (const [key, held] of watching) {
      if (held.messages !== messages) continue;
      watching.delete(key);
      held.resolve(reason);
    }
    // A question a gone node never answered: the caller is told, rather than left waiting on a connection that is over.
    for (const [id, held] of asking) {
      if (held.messages !== messages) continue;
      asking.delete(id);
      held.settle(null);
    }
  };

  /**
   * Watches a process on another node: `ended` settles with the reason it ended, and never rejects.
   *
   * The watcher is a pid of this side minted for the occasion — an answer is addressed to one, and this side is the only
   * reader of those addresses.
   */
  const watchOver = async (to: Term, ref: NodeRef): Promise<Watch> => {
    const where = await connection(ref);
    const watcher = addressFor({ pname: `watch:${nextRef}`, id: Symbol("watch") });
    const minted = reference(cluster.self, cluster.creation, [nextRef, 0, 0, 0]);
    nextRef += 1;
    const key = minted.bytes.toString("hex");
    const ended = new Promise<Term>((resolve) => watching.set(key, { resolve, messages: where.messages }));
    await where.messages.send({
      kind: "message",
      control: { kind: "monitor", from: watcher, to, ref: minted },
      payload: null,
    });
    return {
      ended,
      cancel: () => {
        // A watch already answered is gone from the table, and the peer is not owed a second word about it.
        if (!watching.delete(key)) return;
        void where.messages
          .send({ kind: "message", control: { kind: "demonitor", from: watcher, to, ref: minted }, payload: null })
          .catch(() => undefined);
      },
    };
  };

  /** Settles the watch a ref names: what a peer answered on the connection the watch went over. */
  const answered = (ref: Term, reason: Term): void => {
    if (ref.kind !== "ref") return;
    const key = ref.bytes.toString("hex");
    const held = watching.get(key);
    if (held === undefined) return;
    watching.delete(key);
    held.resolve(reason);
  };


  /**
   * Asks a node to run `module:function(args)` and answers what it answered.
   *
   * The door is `rex`, the RPC server the `rpc` application registers on every node: `{6, From, '', rex}` carrying
   * `{From, {call, Module, Function, Args}}`, answered to `From` as `{rex, From, Reply}`. An application asks for what it
   * needs through this — `erlang:whereis` among other things — rather than the node knowing any one of those questions.
   *
   * The address is served by nothing, so the answer is read off this table rather than delivered to a process.
   */
  const rpc = async (ref: NodeRef, call: Start): Promise<VisibleTerm> => {
    const where = await connection(ref);
    const asked = addressFor({ pname: `call:${nextRef}`, id: Symbol("call") });
    nextRef += 1;
    const answer = new Promise<Term | null>((settle) => asking.set(asked.id, { settle, messages: where.messages }));
    const request = tuple(atom("call"), atom(call.module), atom(call.function), forWire(list(...call.args), pidOf));
    try {
      await where.messages.send({
        kind: "message",
        control: { kind: "regSend", from: asked, to: "rex" },
        payload: tuple(asked, request),
      });
      // A node whose `rpc` application is not running holds no `rex`, and erts drops a message to a name nobody holds
      // without a word: without a bound, the caller would wait on an answer that is never coming.
      const said = await withTimeout(
        answer,
        cluster.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        `${ref.node}@${ref.host} did not answer an RPC: a node serves one only with the rpc application running`,
      );
      if (said === null) throw new Error(`the connection to ${ref.node}@${ref.host} went before it answered`);
      const replied =
        said.kind === "tuple" && said.items.length === 3 && said.items[0]?.kind === "atom" && said.items[0].name === "rex";
      if (!replied) throw new Error(`${ref.node}@${ref.host} answered ${render(said)}, and an RPC answers {rex, From, Reply}`);
      return forHere(said.items[2] ?? atom(""), {
        here: (pid) => reach.processOf(pid),
        there: (pid) => processAt(pid, reach),
      });
    } finally {
      asking.delete(asked.id);
    }
  };

  /** The starts this side asked for, by the octets of the ref it minted: the answer carries that ref back. */
  const starting = new Map<
    string,
    { resolve: (pid: PidTerm) => void; reject: (why: Error) => void; messages: Channel<WireMessage> }
  >();

  /** The answer to a start: a pid for the process, or the word the node refused it with. */
  const answeredStart = (ref: Term, answer: Term): void => {
    if (ref.kind !== "ref") return;
    const key = ref.bytes.toString("hex");
    const held = starting.get(key);
    if (held === undefined) return;
    starting.delete(key);
    if (answer.kind === "pid") {
      held.resolve(answer);
      return;
    }
    held.reject(new Error(`the node refused to start a process: ${render(answer)}`));
  };

  /** A connection that went cannot answer: every start it carried is refused rather than left waiting. */
  const startFailed = (messages: Channel<WireMessage>, why: Error): void => {
    for (const [key, held] of starting) {
      if (held.messages !== messages) continue;
      starting.delete(key);
      held.reject(why);
    }
  };

  /**
   * Asks a node to start `module:function(args)` and answers a handle to the process it started.
   *
   * Erlang's own vocabulary: a module, a function and its arity in the control tuple, the arguments in the message after
   * it. What comes back names the ref this side minted, and carries the pid or the reason it was refused.
   */
  const startOn = async (ref: NodeRef, call: Start): Promise<ErlangProcess> => {
    const where = await connection(ref);
    const from = addressFor({ pname: `spawn:${nextRef}`, id: Symbol("spawn") });
    const minted = reference(cluster.self, cluster.creation, [nextRef, 0, 0, 0]);
    nextRef += 1;
    const started = new Promise<PidTerm>((resolve, reject) => {
      starting.set(minted.bytes.toString("hex"), { resolve, reject, messages: where.messages });
    });
    await where.messages.send({
      kind: "message",
      control: {
        kind: "spawn",
        ref: minted,
        from,
        groupLeader: from,
        call: tuple(atom(call.module), atom(call.function), integer(call.args.length)),
        options: list(),
      },
      payload: forWire(list(...call.args), pidOf),
    });
    return processAt(await started, reach);
  };

  /** The reader a connection of this side needs: an answer is read on the wire the question went out over. */
  const readsAnswers = (said: WireMessage): void => {
    if (said.kind !== "message") return;
    const control = said.control;
    if (control.kind === "monitorExit") {
      answered(control.ref, control.reason);
      return;
    }
    if (control.kind === "spawnReply") answeredStart(control.ref, control.answer);
  };

  /** The process this node serves that a pid of this node names: a pid of a process it does not serve names nobody. */
  const servedBy = (pid: PidTerm): AnyProcess | null => {
    const holder = holderOf(pid);
    return holder === null ? null : (byId.get(holder.id) ?? null);
  };

  /** One term to a name a node registered. `{6, From, '', Name}` carries a sender, so one is given. */
  const sendReg = async (name: string, ref: NodeRef, body: Term, from: TermSender): Promise<void> => {
    const messages = await channel(ref);
    await messages.send({
      kind: "message",
      control: { kind: "regSend", from: senderPidOf(from, pidOf), to: name },
      payload: forWire(body, pidOf),
    });
  };

  /** Ends a process of another node with `kill`. `{3, From, To, kill}` carries a sender, so this node mints one. */
  const killOn = async (pid: PidTerm): Promise<void> => {
    const from = addressFor({ pname: `exit:${nextRef}`, id: Symbol("exit") });
    nextRef += 1;
    await controlTo(pid, { kind: "exit", from, to: pid, reason: atom("kill") });
  };

  /** Links a process this node serves to one over there: whichever ends first takes the other with it. */
  const linkFrom = async (from: PidTerm, to: PidTerm): Promise<void> => {
    const process = byPid(from);
    if (process === null) throw new Error(`${cluster.self} serves no ${render(from)}, so nothing here can be linked`);
    linkTo(process, to);
    await controlTo(to, { kind: "link", from: pidFor(process), to });
  };

  /** This side as the translators read it: a pid becomes its process here, and one over there keeps its address. */
  const reach: Reach = {
    pidOf,
    processOf: servedBy,
    send: sendTo,
    sendReg,
    watch: (pid: PidTerm) => watchOver(pid, refOf(pid, cluster.name)),
    watchName: (ref: NodeRef, name: string) => watchOver(atom(name), ref),
    kill: killOn,
    link: linkFrom,
    spawn: startOn,
    rpc,
  };

  /** Says a connection a peer opened is how a pid on that node is answered, so this side sends over it, not a second. */
  const adopt = (peer: Peer, messages: Channel<WireMessage>): void => {
    const ref = refOf({ kind: "pid", node: peer.name, id: 0, serial: 0, creation: peer.creation }, cluster.name);
    reached.set(nodeName(ref), Promise.resolve({ messages, peer }));
    reached.set(peer.name, Promise.resolve({ messages, peer }));
    // A watch this side sets is answered on whichever wire it went over, an arrived connection included.
    messages.onFrame(readsAnswers);
    // A connection a peer opened is the way to it until it ends: after that a pid on that node opens a new one.
    messages.onClose(() => {
      reached.delete(nodeName(ref));
      reached.delete(peer.name);
      settleOver(messages, atom("noconnection"));
      startFailed(messages, new Error("the connection went before the node answered"));
    });
  };

  /** Lets go of every connection this side dialled, and of the mapper it started, if there was one. */
  const closeConnections = async (): Promise<void> => {
    const all = [...dialled];
    dialled.clear();
    reached.clear();
    for (const messages of all) await messages.close("this side is done").catch(() => undefined);
    // A mapper this runtime started goes with it: the registrations were connections to it, and both end here.
    await ownMapper?.close().catch(() => undefined);
    ownMapper = null;
  };
  const listener: Listener = await listen(
    {
      self: cluster.self,
      cookie: cluster.cookie,
      creation: cluster.creation,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(cluster.flags === undefined ? {} : { flags: cluster.flags }),
      ...(cluster.timeoutMs === undefined ? {} : { timeoutMs: cluster.timeoutMs }),
    },
    {
      onConnection(peer, messages) {
        // A connection that arrived is how a pid on that node is answered: this side sends over this one rather than
        // opening a second, and this node reads what comes back.
        adopt(peer, messages);
        attach(messages);
      },
      onRefused(error) {
        console.error(`erlang-node: ${cluster.self} refused a connection: ${error.message}`);
      },
    },
  );

  let registration: Registration | null = null;
  try {
    registration = announce === false ? null : await announce(listener.port);
  } catch (error) {
    await listener.close();
    throw error;
  }

  const made: ErlangNode = {
    name: cluster.self,
    port: listener.port,
    registerProcess,
    attach,
    channel,
    send: sendTo,
    sendReg,
    watch: reach.watch,
    watchName: reach.watchName,
    spawn: startOn,
    rpc,
    pidOf,
    processOf: servedBy,
    kill: reach.kill,
    link: reach.link,
    async unlink(from: PidTerm, to: PidTerm): Promise<void> {
      const process = byPid(from);
      if (process === null) return;
      unlinkFrom(process, to);
      await controlTo(to, { kind: "unlink", from: pidFor(process), to });
    },
    async close(): Promise<void> {
      // Unreachable by name first: nothing new is started against a node that is going.
      forgetNode(cluster.name);
      await registration?.close();
      for (const stop of reading.values()) stop();
      reading.clear();
      for (const stop of leaving.values()) stop();
      leaving.clear();
      byName.clear();
      byId.clear();
      watches.clear();
      // The answers already queued go out before the wire they go over: a peer that watched a process reads why it
      // ended, and `noconnection` is a different fact.
      await Promise.allSettled(sending);
      // And then the connections, this side's and the ones a peer opened: they end with the node they reach.
      await closeConnections();
      await listener.close();
    },
  };
  // Reachable by name, so an actor given a cluster name finds this node rather than a connection table.
  installNode(made, cluster.name);
  return made;
}

/** Whether an out-message of a served process is a term to send. Its EXIT arrives on the same channel. */
function isAnswer(message: Message): message is EtfAnswered {
  return message.type === "ETF_RAW";
}

/** How an address reads in a refusal. */
function described(control: Control): string {
  if (control.kind === "regSend") return `the name ${control.to}`;
  if (control.kind !== "send" || control.to.kind !== "pid") return "an address this side does not read";
  return `the pid ${control.to.node}.${control.to.id}`;
}

/**
 * The failure a process died of, as a peer reads it: `{error, Message}`.
 *
 * A term of its own, so a peer can match it. The stack is not carried: what a peer acts on is that this was a failure,
 * and a sentence is what this side has.
 */
function failureTerm(failure: unknown): Term {
  return tuple(atom("error"), binary(Buffer.from(failure instanceof Error ? failure.message : String(failure), "utf8")));
}

/** The verbs an actor uses of a running node: what `installNode` is given and `nodeNamed` answers. */
export type { Reach };

/** The nodes this runtime runs, by the cluster name their configuration carries: what an actor resolves by name. */
const running = new Map<string, Reach>();

/** Says a node is running, so an actor that was given its name can reach it. */
export function installNode(node: Reach, cluster: string = DEFAULT_CLUSTER): void {
  running.set(cluster, node);
}

/** The node running under a cluster name, or a sentence saying which ones there are. */
export function nodeNamed(cluster: string = DEFAULT_CLUSTER): Reach {
  const found = running.get(cluster);
  if (found !== undefined) return found;
  const known = [...running.keys()].join(", ");
  throw new Error(`there is no node running as ${cluster}: this runtime has ${known === "" ? "none" : known}`);
}

/** Forgets a node by name: what a runtime does when it shuts one down. */
export function forgetNode(cluster: string = DEFAULT_CLUSTER): void {
  running.delete(cluster);
}
