// ── reaching a pid ──────────────────────────────────────────────────────────
//
// A pid names a node and a process on it. Sending to one this side has no connection to means asking the mapper at
// that node's host where it listens, proving the cookie, and keeping the channel for the next message. That is what
// makes an answer to somebody else's pid arrive: the pid carries the address, and this is the rule that follows it.

import type { Channel } from "posipaki/port";
import { socketChannel } from "posipaki/port/node";

import { open } from "./connection.js";
import { epmdPort } from "./epmd.js";
import type { WireMessage } from "./messages.js";
import type { Term } from "./terms.js";

/** A pid, as the wire writes it: a node, an id, a serial, and the incarnation of the node that minted it. */
export type PidTerm = Extract<Term, { kind: "pid" }>;

export interface NetworkOptions {
  /** The name this side answers to: a pid on it is this side's own, and is not sent over a wire. */
  readonly self: string;
  readonly cookie: string;
  readonly creation: number;
  readonly flags?: readonly [high: number, low: number];
  readonly timeoutMs?: number;
  /** Where a node listens. Default: the mapper at the node's host. */
  readonly locate?: (node: string) => Promise<number>;
}

/** The nodes this side can reach, made as they are named. */
export interface Network {
  /** Sends `payload` to `pid`, connecting to its node if this side has no connection to it yet. */
  send(pid: PidTerm, payload: Term): Promise<void>;
  /** The channel to a node, up once its handshake is done. */
  channel(node: string): Promise<Channel<WireMessage>>;
  close(): Promise<void>;
}

/** The node in a pid, as its name and its host. */
function splitNode(node: string): { name: string; host: string } {
  const at = node.indexOf("@");
  if (at <= 0 || at === node.length - 1) throw new Error(`${node} is not a node name: it has no host`);
  return { name: node.slice(0, at), host: node.slice(at + 1) };
}

export function network(options: NetworkOptions): Network {
  const channels = new Map<string, Promise<Channel<WireMessage>>>();
  const locate =
    options.locate ??
    (async (node: string): Promise<number> => {
      const { name, host } = splitNode(node);
      return epmdPort(await socketChannel({ host, port: EPMD_PORT }), { host, name });
    });

  const channel = (node: string): Promise<Channel<WireMessage>> => {
    const known = channels.get(node);
    if (known !== undefined) return known;
    if (node === options.self) {
      return Promise.reject(new Error(`${node} is this side's own name: a pid on it is not sent over a wire`));
    }
    const { name, host } = splitNode(node);
    const made = (async () => {
      const port = await locate(node);
      const connection = await open(port, {
        host,
        node: name,
        cookie: options.cookie,
        self: options.self,
        creation: options.creation,
        ...(options.flags === undefined ? {} : { flags: options.flags }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      connection.messages.onClose(() => channels.delete(node));
      return connection.messages;
    })();
    const guarded = made.catch((error: unknown) => {
      channels.delete(node);
      throw error;
    });
    channels.set(node, guarded);
    return guarded;
  };

  return {
    channel,
    async send(pid: PidTerm, payload: Term): Promise<void> {
      const messages = await channel(pid.node);
      await messages.send({ kind: "message", control: { kind: "send", to: pid }, payload });
    },
    async close(): Promise<void> {
      const all = [...channels.values()];
      channels.clear();
      for (const made of all) {
        const messages = await made.catch(() => null);
        await messages?.close("this side is done").catch(() => undefined);
      }
    },
  };
}

/** The port of the mapper on every host this protocol talks to. */
const EPMD_PORT = 4369;
