// ── a node, from this side: the processes this side serves ──────────────────
//
// The mirror of the proxy. A proxy is one process of another node, seen from here; a node is this side, seen from
// there: a listener, the registration that makes it findable in a mapper, and the processes it answers for.
//
// It is not a process. Nothing waits in a mailbox for a frame — a connection is read where its frames arrive — and a
// served process is an ordinary actor: it hears one term as an in-message, `{from, body}`, and answers with one
// out-message, `{to, body}`.
//
// The two tables are the whole of the routing: a name a node sends to, and a pid the cluster minted for a process this
// node serves. A pid for a process it does not serve names nobody here, however well the cluster knows it.

import type { AnyProcess, Message } from "posipaki";
import type { Channel } from "posipaki/port";

import {
  DEFAULT_CLUSTER,
  refOf,
  type Cluster,
  type NodeRef,
  type PidTerm,
  type ProcessHandle,
  type Start,
  type Watch,
} from "./cluster.js";
import type { Control } from "./control.js";
import type { Registration } from "./epmd.js";
import { listen, type Listener } from "./listen.js";
import type { WireMessage } from "./messages.js";
import { forHere, forWire, remoteProcess, type RemoteProcess, type VisibleTerm } from "./processes.js";
import { atom, binary, render, tuple, type Term } from "./terms.js";

/** A term from a node, and who asked. `from` is absent when the wire did not say: a send addressed to us carries none. */
export interface EtfAsked {
  type: "ETF_RAW";
  from?: RemoteProcess;
  body: VisibleTerm;
}

/** A term to a process, as a served process answers. */
export interface EtfAnswered {
  type: "ETF_RAW";
  to: RemoteProcess;
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

/** What a node is, before it has a port: the identity its connections are proved with, and the cluster it belongs to. */
export interface NodeFacts {
  /** The cluster this node mints pids in, and sends through when a served process answers a pid of another node. */
  readonly cluster: Cluster;
  /** The name this node answers to on the wire, `name@host`: the same one every pid it mints carries. */
  readonly self: string;
  readonly cookie: string;
  /** This node's incarnation, which every pid it writes carries. */
  readonly creation: number;
  /** How this node makes itself findable: what a peer's lookup asks its host's mapper, or `false` for neither. */
  readonly announce: Announce;
  readonly flags?: readonly [number, number];
  readonly timeoutMs?: number;
}

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
  /** Serves a process under a name: what another node addresses it by. A name already served is refused. */
  serve(name: string, process: AnyProcess): void;
  /** Serves the processes on a connection whose frames nobody else reads — one this side opened. */
  attach(messages: Channel<WireMessage>): void;
  /** The channel to one node, opened on first use and shared by everything that addresses it. */
  channel(ref: NodeRef): Promise<Channel<WireMessage>>;
  /** One term to a process of another node. `{2, '', To}` carries no sender. */
  send(pid: PidTerm, body: Term): Promise<void>;
  /** One term to a registered name. `{6, From, '', Name}` carries the sender, so one is needed. */
  sendReg(name: string, ref: NodeRef, body: Term, from: AnyProcess): Promise<void>;
  /** Watches a process of another node: what settles with the reason it ended. */
  watch(pid: PidTerm): Promise<Watch>;
  /** The same watch, where the other node knows the process by a registered name. */
  watchName(ref: NodeRef, name: string): Promise<Watch>;
  /** Asks a node to start `module:function(args)` and answers a handle to the process. */
  spawn(ref: NodeRef, call: Start): Promise<RemoteProcess>;
  /** The pid this node answers at for a process it serves, minted once for its lifetime. */
  pidOf(process: ProcessHandle): PidTerm;
  /** The process a pid names here, or null for a pid this node does not serve. */
  processOf(pid: PidTerm): AnyProcess | null;
  close(): Promise<void>;
}

/** Starts a node: listens, announces itself where it is told, and serves what `serve` is given. */
export async function startNode(facts: NodeFacts, options: NodeOptions = {}): Promise<ErlangNode> {
  const cluster = facts.cluster;
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
    const messages = await facts.cluster.channel(refOf(pid, facts.cluster.name));
    await messages.send({ kind: "message", control: said, payload: null });
  };

  /** The pid this node answers at for a process it serves. */
  const pidFor = (process: AnyProcess): PidTerm => facts.cluster.pidOf({ pname: process.pname, id: process.id });

  /** Watches a peer set, by the octets of the ref it minted: one table, walked when a process ends. */
  const watches = new Map<string, PeerWatch>();
  /** The answers on their way out: `close` lets them finish before the connections they go over are let go. */
  const sending = new Set<Promise<void>>();

  /** The process a pid names, when this node serves it. A pid of a process it does not serve names nobody here. */
  const byPid = (address: Term): AnyProcess | null => {
    if (address.kind !== "pid") return null;
    const holder = cluster.processOf(address);
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
          `erlang-node: ${facts.self} could not say why a process ended: ${
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
      console.error(`erlang-node: ${facts.self} was asked to watch without a ref to answer by: ${render(ref)}`);
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
        console.error(`erlang-node: ${facts.self} was told a linked process ended, and serves no ${render(control.to)}`);
        return;
      }
      void process.stop();
      return;
    }
    if (control.kind !== "send" && control.kind !== "regSend") return;

    const process = control.kind === "regSend" ? (byName.get(control.to) ?? null) : byPid(control.to);
    if (process === null) {
      // erts drops a message for a name nobody answers without a word. This side says it once and keeps the
      // connection: another node's bookkeeping is not a reason to fail a wire.
      console.error(`erlang-node: ${facts.self} was addressed ${described(control)}, which serves nobody here`);
      return;
    }

    const asked: EtfAsked = {
      type: "ETF_RAW",
      ...(control.kind === "regSend" && control.from.kind === "pid" ? { from: remoteProcess(control.from, cluster) } : {}),
      body: forHere(said.payload ?? atom(""), {
        here: (pid) => cluster.processOf(pid),
        there: (pid) => remoteProcess(pid, cluster),
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

  const serve = (name: string, process: AnyProcess): void => {
    const known = byName.get(name);
    if (known !== undefined && known.id !== process.id) {
      throw new Error(`${facts.self} already serves ${name} with ${known.pname}`);
    }
    byName.set(name, process);
    if (byId.has(process.id)) return;

    byId.set(process.id, process);
    // The address a node will write for this process, minted now: the cluster answers by it, and this node looks it up.
    cluster.pidOf({ pname: process.pname, id: process.id });
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

  const listener: Listener = await listen(
    {
      self: facts.self,
      cookie: facts.cookie,
      creation: facts.creation,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(facts.flags === undefined ? {} : { flags: facts.flags }),
      ...(facts.timeoutMs === undefined ? {} : { timeoutMs: facts.timeoutMs }),
    },
    {
      onConnection(peer, messages) {
        // A connection that arrived is how a pid on that node is answered: the cluster sends over this one rather than
        // opening a second, and this node reads what comes back.
        cluster.adopt(peer, messages);
        attach(messages);
      },
      onRefused(error) {
        console.error(`erlang-node: ${facts.self} refused a connection: ${error.message}`);
      },
    },
  );

  let registration: Registration | null = null;
  try {
    registration = facts.announce === false ? null : await facts.announce(listener.port);
  } catch (error) {
    await listener.close();
    throw error;
  }

  const made: ErlangNode = {
    name: facts.self,
    port: listener.port,
    serve,
    attach,
    channel: (ref: NodeRef) => facts.cluster.channel(ref),
    send: (pid: PidTerm, body: Term) => facts.cluster.send(pid, body),
    sendReg: async (name: string, ref: NodeRef, body: Term, from: AnyProcess) => {
      // `{6, From, '', Name}` carries a sender; a process of this side, named by its pid, is what goes there.
      const messages = await facts.cluster.channel(ref);
      await messages.send({
        kind: "message",
        control: { kind: "regSend", from: facts.cluster.pidOf({ pname: from.pname, id: from.id }), to: name },
        payload: forWire(body, (handle) => facts.cluster.pidOf(handle)),
      });
    },
    watch: (pid: PidTerm) => facts.cluster.watch(pid),
    watchName: (ref: NodeRef, name: string) => facts.cluster.watchName(ref, name),
    spawn: (ref: NodeRef, call: Start) => facts.cluster.spawn(ref, call),
    pidOf: (process: ProcessHandle) => facts.cluster.pidOf({ pname: process.pname, id: process.id }),
    processOf: (pid: PidTerm) => {
      const known = facts.cluster.processOf(pid);
      return known === null ? null : (byId.get(known.id) ?? null);
    },
    async link(from: PidTerm, to: PidTerm): Promise<void> {
      const process = byPid(from);
      if (process === null) throw new Error(`${facts.self} serves no ${render(from)}, so nothing here can be linked`);
      linkTo(process, to);
      await controlTo(to, { kind: "link", from: pidFor(process), to });
    },
    async unlink(from: PidTerm, to: PidTerm): Promise<void> {
      const process = byPid(from);
      if (process === null) return;
      unlinkFrom(process, to);
      await controlTo(to, { kind: "unlink", from: pidFor(process), to });
    },
    async close(): Promise<void> {
      await registration?.close();
      // Unregistered first, so nothing new arrives while the connections are let go.
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
      await listener.close();
    },
  };
  // Reachable by name, so an actor given a cluster name finds this node rather than a connection table.
  installNode(made, facts.cluster.name);
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

/** What an actor needs to reach a running node: the verbs, not the node. */
export type Reach = Pick<ErlangNode, "channel" | "pidOf" | "processOf" | "send" | "watch" | "watchName">;

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
