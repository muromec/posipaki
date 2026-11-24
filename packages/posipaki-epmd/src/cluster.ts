// ── a cluster: the nodes this runtime can reach ─────────────────────────────
//
// A node is *named*, never held: `NodeRef` is a cluster and a node in it, and this is the thing that turns a name into
// a connection. Three jobs, and they are all here because they are all about the same table:
//
//   discovery   where a node listens — the mapper at its host, or a caller's own answer
//   multiplex   one channel per node, shared by every proxy that addresses it
//   addressing  the pids this side answers at, one per proxy, minted here so two cannot collide
//
// A connection is opened on first use and kept. A node that restarts is a new incarnation, and a pid from before it is
// refused rather than delivered to whoever answers now.

import type { Channel } from "posipaki/port";
import { socketChannel } from "posipaki/port/node";

import { open } from "./connection.js";
import { epmdPort } from "./epmd.js";
import type { Peer } from "./handshake.js";
import type { WireMessage } from "./messages.js";
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
}

/** The nodes one identity of this runtime can reach. */
export interface Cluster {
  readonly name: string;
  /** The channel to one node, opened on first use and shared by everything that addresses it. */
  channel(ref: NodeRef): Promise<Channel<WireMessage>>;
  /** A pid of this side for one proxy: a new id per call, so two proxies on a node are two addresses. */
  address(ref: NodeRef): PidTerm;
  /** Sends `payload` to `pid`, connecting to its node if nothing has yet. */
  send(pid: PidTerm, payload: Term): Promise<void>;
  /** Says a connection this side did not open — one that arrived — so a pid on that node uses it. */
  adopt(peer: Peer, messages: Channel<WireMessage>): void;
  close(): Promise<void>;
}

/** A pid, as the wire writes it: a node, an id, a serial, and the incarnation of the node that minted it. */
export type PidTerm = Extract<Term, { kind: "pid" }>;

/** A connection as this file needs it: the way to a node, and which incarnation answered. */
interface Reached {
  readonly messages: Channel<WireMessage>;
  readonly peer: Peer;
}

export function makeCluster(options: ClusterOptions): Cluster {
  const name = options.name ?? DEFAULT_CLUSTER;
  const reached = new Map<string, Promise<Reached>>();
  let nextId = 1;
  const addresses = new WeakMap<NodeRef, PidTerm>();

  const locate =
    options.locate ??
    (async (ref: NodeRef): Promise<number> => {
      return epmdPort(await socketChannel({ host: ref.host, port: EPMD_PORT }), { host: ref.host, name: ref.node });
    });

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
      return { messages: opened.messages, peer: opened.peer };
    })();
    const guarded = made.catch((error: unknown) => {
      reached.delete(key);
      throw error;
    });
    reached.set(key, guarded);
    return guarded;
  };

  return {
    name,
    channel: async (ref: NodeRef) => (await connection(ref)).messages,
    address(ref: NodeRef): PidTerm {
      // One reference is one proxy's identity, so it is minted once: a caller that puts its pid in a message and the
      // actor that sends from it are then talking about the same address.
      const known = addresses.get(ref);
      if (known !== undefined) return known;
      const minted: PidTerm = { kind: "pid", node: options.self, id: nextId++, serial: 0, creation: options.creation };
      addresses.set(ref, minted);
      return minted;
    },
    adopt(peer: Peer, messages: Channel<WireMessage>): void {
      const ref = refOf({ kind: "pid", node: peer.name, id: 0, serial: 0, creation: peer.creation }, name);
      reached.set(nodeName(ref), Promise.resolve({ messages, peer }));
      reached.set(peer.name, Promise.resolve({ messages, peer }));
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
    async close(): Promise<void> {
      const all = [...reached.values()];
      reached.clear();
      for (const made of all) {
        const found = await made.catch(() => null);
        await found?.messages.close("this side is done").catch(() => undefined);
      }
    },
  };
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
