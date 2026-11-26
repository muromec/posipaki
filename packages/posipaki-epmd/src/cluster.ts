// ── a cluster: the configuration a node runs from, and the grammar of a name ─
//
// A node of another runtime is *named*, never held: `NodeRef` is a cluster and a node in it, so what a reference is and
// how a joined name is spelled live here. The settings are the ones a node of this side is started with: what it answers
// to, the cookie its connections are proved with, its incarnation, where a peer is looked up, how it announces itself,
// and what it does about the mapper on its own host.
//
// Nothing here holds a connection, a pid or a watch. Those belong to the node: `startNode` in `node.ts`.

import type { Term } from "./terms.js";
import type { Registration } from "./epmd.js";

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

/** A watch this side set: what settles with the reason, and how to stop waiting for it. */
export interface Watch {
  /** Settles with the reason the process ended. It never rejects: a peer that goes answers `noconnection`. */
  readonly ended: Promise<Term>;
  /** Stops waiting. The peer is told, and `ended` stays pending. */
  cancel(): void;
}



/** A pid, as the wire writes it: a node, an id, a serial, and the incarnation of the node that minted it. */
export type PidTerm = Extract<Term, { kind: "pid" }>;


/** A cluster: the configuration a node of this runtime runs from, under the name a reference reaches it by. */
export interface Cluster extends ClusterOptions {
  readonly name: string;
}

/** Resolves the one default a cluster has: the name it is reached by. */
export function makeCluster(options: ClusterOptions): Cluster {
  return { ...options, name: options.name ?? DEFAULT_CLUSTER };
}
