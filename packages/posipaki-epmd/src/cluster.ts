// ── a cluster: the nodes this runtime can reach, and the one it is ──────────
//
// A node of another runtime is *named*, never held: `NodeRef` is a cluster and a node in it, and this is the thing
// that turns a name into a connection. Four jobs, and they are all here because they are all about the same table:
//
//   discovery   where a node listens — the mapper at its host, or a caller's own answer
//   multiplex   one channel per node, shared by every proxy that addresses it
//   addressing  the pids this side answers at, one per proxy, minted here so two cannot collide
//   serving     this side as a node — `node()` listens, registers with a mapper, and reads every connection, so a peer
//               reaches the processes here
//
// A connection is opened on first use and kept. A node that restarts is a new incarnation, and a pid from before it is
// refused rather than delivered to whoever answers now.

import type { Channel } from "posipaki/port";
import { socketChannel } from "posipaki/port/node";

import { open } from "./connection.js";
import {
  epmdPort,
  epmdRegister,
  mapperAnswers,
  MapperPortTaken,
  serveEpmd,
  type Mapper,
  type Registration,
} from "./epmd.js";
import type { Peer } from "./handshake.js";
import type { WireMessage } from "./messages.js";
import { startNode, type Announce, type ErlangNode, type NodeOptions } from "./node.js";
import type { Term } from "./terms.js";

/** The cluster a node is looked up in when a reference names none. */
export const DEFAULT_CLUSTER = "default";

/** A node, as it is named: the cluster to look it up in, its name there, and the host that answers for it. */
export interface NodeRef {
  readonly cluster: string;
  /** The node's name in the mapper, without a host: `robot` for `robot@192.168.88.20`. */
  readonly node: string;
  /** Where that name is found: the host to ask the mapper on. */
  readonly host: string;
}

/** A node's name, as the wire spells it: one atom, `name@host`. */
export function nodeName(ref: NodeRef): string {
  return `${ref.node}@${ref.host}`;
}
/** The reference a joined node name names, in the cluster it was reached through. */
export function refFromName(node: string, cluster: string = DEFAULT_CLUSTER): NodeRef {
  const at = node.indexOf("@");
  if (at <= 0 || at === node.length - 1) {
    throw new Error(`${node} is not a node name: it has no host`);
  }
  return { cluster, node: node.slice(0, at), host: node.slice(at + 1) };
}

/** The reference a pid names. A pid carries the joined name and nothing else. */
export function refOf(pid: PidTerm, cluster: string = DEFAULT_CLUSTER): NodeRef {
  return refFromName(pid.node, cluster);
}


/** A node's name in a cluster, as a reference. */
export function nodeRef(node: string, host: string, cluster: string = DEFAULT_CLUSTER): NodeRef {
  return { cluster, node, host };
}

export interface ClusterOptions {
  /** What this cluster is called. A reference names it; `default` when nobody said. */
  readonly name?: string;
  /** The name this runtime answers to. */
  readonly self: string;
  readonly cookie: string;
  /** This runtime's incarnation: every pid it mints carries it, and a peer refuses a pid that disagrees. */
  readonly creation: number;
  readonly flags?: readonly [high: number, low: number];
  readonly timeoutMs?: number;
  /** Where a node is. Default: the mapper at the node's host. */
  readonly locate?: (ref: NodeRef) => Promise<number>;
  /**
   * How this runtime's own node is announced, given its reference and the port it listens on.
   *
   * Default: the mapper at that reference's host, the same one `locate` asks — the two directions of one fact.
   * `false` runs a node nobody can look up, for a caller that names the port itself.
   */
  readonly announce?: ((ref: NodeRef, port: number) => Promise<Registration>) | false;
  /**
   * What this runtime does about the mapper on its own host, when it was not given a way to announce itself.
   *
   * `start: "never"` (the default) requires a mapper that already answers, which is a host with a real epmd on it.
   * `"auto"` serves one when none does, which is what a host running only this runtime needs. `port` is the mapper's,
   * 4369 unless a caller names another.
   */
  readonly epmd?: { readonly port?: number; readonly start?: "auto" | "never" };
}

/** What this runtime knows a process by: its name in the tree, and the symbol the framework gave it. */
export interface ProcessHandle {
  readonly pname: string;
  readonly id: symbol;
}

/** The nodes one identity of this runtime can reach. */
export interface Cluster {
  readonly name: string;
  /** The channel to one node, opened on first use and shared by everything that addresses it. */
  channel(ref: NodeRef): Promise<Channel<WireMessage>>;
  /**
   * The node-scoped pid of one process: minted once for its lifetime, from the process's own id, and never reused.
   *
   * This is what a peer addresses. A process asks for its pid when it wants to be reachable — the same value comes
   * back however many times it is asked, and whoever holds the process's handle asks for the same one.
   */
  pidOf(process: ProcessHandle): PidTerm;
  /** The process a pid names, or null: a pid this runtime minted, in the incarnation it is running now. */
  processOf(pid: PidTerm): ProcessHandle | null;
  /** Sends `payload` to `pid`, connecting to its node if nothing has yet. */
  send(pid: PidTerm, payload: Term): Promise<void>;
  /** Says a connection this side did not open — one that arrived — so a pid on that node uses it. */
  adopt(peer: Peer, messages: Channel<WireMessage>): void;
  /** Starts a node under this runtime's name: it listens, registers with the mapper, and serves what is given to it. */
  node(options?: NodeOptions): Promise<ErlangNode>;
  close(): Promise<void>;
}


/** A pid, as the wire writes it: a node, an id, a serial, and the incarnation of the node that minted it. */
export type PidTerm = Extract<Term, { kind: "pid" }>;

/** A connection as this file needs it: the way to a node, and which incarnation answered. */
interface Reached {
  readonly messages: Channel<WireMessage>;
  readonly peer: Peer;
}

/** How a cluster's node announces itself: the cluster's own way of telling, or the mapper at the node's host. */
function announcing(name: string, options: ClusterOptions, join: Tell): Announce {
  if (options.announce === false) return false;
  const ref = refFromName(options.self, name);
  const tell = options.announce ?? join;
  return async (port: number) => tell(ref, port);
}

/** Where a node's registration goes: the mapper one asks, and the port this runtime listens on. */
type Tell = (ref: NodeRef, port: number) => Promise<Registration>;

export function makeCluster(options: ClusterOptions): Cluster {
  const name = options.name ?? DEFAULT_CLUSTER;
  const reached = new Map<string, Promise<Reached>>();
  let nextId = 1;
  /** How to read a connection as this node: set when one is started, so every way a connection is made is served. */
  let serving: ((messages: Channel<WireMessage>) => void) | null = null;

  /** The pid each process answers at, by the symbol the framework gave it, and who each pid names. */
  const pids = new Map<symbol, PidTerm>();
  const owners = new Map<number, ProcessHandle>();

  const locate =
    options.locate ??
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
    const mapperPort = options.epmd?.port ?? EPMD_PORT;
    if (options.epmd?.start === "auto" && !(await mapperAnswers(ref.host, mapperPort))) {
      try {
        ownMapper = await serveEpmd(mapperPort);
      } catch (error) {
        // Another process took the port between the probe and this bind: its mapper answers, so the registration
        // goes there instead of this node failing to start.
        if (!(error instanceof MapperPortTaken)) throw error;
      }
    }
    return epmdRegister({ host: ref.host, name: ref.node, port, mapperPort });
  };

  /** One connection per node, opened on first use: the table is keyed by the name the wire knows it by. */
  const connection = (ref: NodeRef): Promise<Reached> => {
    const key = nodeName(ref);
    const known = reached.get(key);
    if (known !== undefined) return known;
    if (key === options.self) {
      return Promise.reject(new Error(`${key} is this side's own name: a pid on it is not sent over a wire`));
    }
    const made = (async () => {
      const port = await locate(ref);
      const opened = await open(port, {
        host: ref.host,
        node: ref.node,
        cookie: options.cookie,
        self: options.self,
        creation: options.creation,
        ...(options.flags === undefined ? {} : { flags: options.flags }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      opened.messages.onClose(() => reached.delete(key));
      // A connection this side opened is read as well: a node answers on it, not on a second one.
      serving?.(opened.messages);
      return { messages: opened.messages, peer: opened.peer };
    })();
    const guarded = made.catch((error: unknown) => {
      reached.delete(key);
      throw error;
    });
    reached.set(key, guarded);
    return guarded;
  };

  const made: Cluster = {
    name,
    channel: async (ref: NodeRef) => (await connection(ref)).messages,
    pidOf(process: ProcessHandle): PidTerm {
      const known = pids.get(process.id);
      if (known !== undefined) return known;
      const minted: PidTerm = { kind: "pid", node: options.self, id: nextId++, serial: 0, creation: options.creation };
      pids.set(process.id, minted);
      owners.set(minted.id, process);
      return minted;
    },
    processOf(pid: PidTerm): ProcessHandle | null {
      // A pid from another incarnation names nobody here: the id space starts again with the node.
      if (pid.node !== options.self || pid.creation !== options.creation) return null;
      return owners.get(pid.id) ?? null;
    },
    adopt(peer: Peer, messages: Channel<WireMessage>): void {
      const ref = refOf({ kind: "pid", node: peer.name, id: 0, serial: 0, creation: peer.creation }, name);
      reached.set(nodeName(ref), Promise.resolve({ messages, peer }));
      reached.set(peer.name, Promise.resolve({ messages, peer }));
      // A connection a peer opened is the way to it until it ends: after that a pid on that node opens a new one.
      messages.onClose(() => {
        reached.delete(nodeName(ref));
        reached.delete(peer.name);
      });
    },
    async send(pid: PidTerm, payload: Term): Promise<void> {
      const where = await connection(refOf(pid, name));
      if (where.peer.creation !== pid.creation) {
        throw new Error(
          `${pid.node} answers as incarnation ${where.peer.creation}, and this pid was minted by ${pid.creation}: ` +
            "the message is for a node that is not there any more",
        );
      }
      await where.messages.send({ kind: "message", control: { kind: "send", to: pid }, payload });
    },
    async node(nodeOptions: NodeOptions = {}): Promise<ErlangNode> {
      if (serving !== null) {
        throw new Error(`the cluster ${name} already runs a node`);
      }
      const announce = announcing(name, options, joinMapper);
      const started = await startNode(
        {
          cluster: made,
          self: options.self,
          cookie: options.cookie,
          creation: options.creation,
          announce,
          ...(options.flags === undefined ? {} : { flags: options.flags }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
        nodeOptions,
      );
      // From here on every connection is read as this node, however it was made: by a peer that arrived, or by this
      // side reaching out and its answer coming back on the same one.
      serving = (messages) => started.attach(messages);
      return started;
    },
    async close(): Promise<void> {
      const all = [...reached.values()];
      reached.clear();
      for (const pending of all) {
        const found = await pending.catch(() => null);
        await found?.messages.close("this side is done").catch(() => undefined);
      }
      // A mapper this runtime started goes with it: the registrations were connections to it, and both end here.
      await ownMapper?.close().catch(() => undefined);
      ownMapper = null;
    },
  };
  return made;
}

// ── the clusters of this runtime ───────────────────────────────────────────
//
// A reference names a cluster, and the actor that was forked with the reference looks it up by that name: what crosses
// into an actor's arguments is a name, not a connection, so the table of clusters is the one thing that has to be
// reachable from anywhere in the runtime.

const clusters = new Map<string, Cluster>();

/** Makes this cluster the one its name answers to. */
export function installCluster(cluster: Cluster): Cluster {
  clusters.set(cluster.name, cluster);
  return cluster;
}

/** The cluster a reference names, or a sentence naming the ones that are installed. */
export function clusterNamed(name: string = DEFAULT_CLUSTER): Cluster {
  const found = clusters.get(name);
  if (found !== undefined) return found;
  const known = [...clusters.keys()].join(", ");
  throw new Error(`there is no cluster called ${name}: this runtime has ${known === "" ? "none" : known}`);
}

/** Forgets a cluster by name: what a runtime does when it shuts one down. */
export function forgetCluster(name: string = DEFAULT_CLUSTER): void {
  clusters.delete(name);
}

/** The port of the mapper on every host this protocol talks to. */
const EPMD_PORT = 4369;
