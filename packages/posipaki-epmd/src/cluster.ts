// ── a cluster: the name a node is reached in, and the grammar of a name ─────
//
// A node of another runtime is *named*, never held: `NodeRef` is a cluster and a node in it, so what a reference is and
// how a joined name is spelled live here. What the cluster decides for every node started in it is where a peer is
// looked up, and what is done about the mapper on this host.
//
// What a node *is* — its name, cookie, incarnation, flags, whether it registers — belongs to the node: `startNode` in
// `node.ts`. Nothing here holds a connection, a pid or a watch.

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
  /** Where a node is. Default: the mapper at the node's host. */
  readonly locate?: (ref: NodeRef) => Promise<number>;
  /**
   * What this runtime does about the mapper on its own host.
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


/** A cluster: where its nodes are looked up, under the name a node is bound to it by. */
export interface Cluster extends ClusterOptions {
  readonly name: string;
}

/** The clusters this runtime was told about, by the name a node is bound to. */
const clusters = new Map<string, Cluster>();

/**
 * Configures a cluster and installs it under its name: a node started with that name is bound to it.
 *
 * A runtime that needs nothing of this keeps the defaults, and never calls this: `clusterName` is `default` and a
 * `default` cluster is looked up at the mapper on each node's own host.
 */
export function makeCluster(options: ClusterOptions = {}): Cluster {
  const made: Cluster = { ...options, name: options.name ?? DEFAULT_CLUSTER };
  clusters.set(made.name, made);
  return made;
}

/** The cluster a node is bound to: what was installed under that name, and the defaults when nothing was. */
export function clusterNamed(name: string = DEFAULT_CLUSTER): Cluster {
  return clusters.get(name) ?? { name };
}
