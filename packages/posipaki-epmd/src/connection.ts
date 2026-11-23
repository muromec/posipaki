// ── a connection to a node ──────────────────────────────────────────────────
//
// Three facts make a connection: the port the node listens on, which epmd knows; the bytes as frames; and the frames
// as messages with a handshake in between. This is that composition in one place, so a caller says a host, a node
// name and a cookie, and gets a channel of messages.
//
// `open` is the same connection to a port already known. It is separate because epmd's answer is the one part a test
// cannot stand in for: everything above it can be flown against a socket a test is listening on.

import type { Channel } from "posipaki/port";
import { socketChannel } from "posipaki/port/node";

import { epmdPort } from "./epmd.js";
import { wrapEpmdFrame } from "./frame.js";
import { DEFAULT_TIMEOUT_MS, initiate, MANDATORY_FLAGS, type Peer } from "./handshake.js";
import { withMeaning, type WireMessage } from "./messages.js";

const EPMD_PORT = 4369;





export interface ConnectionOptions {
  readonly host: string;
  /** The node's name in epmd, without a host: `robot` for `robot@tomato`. */
  readonly node: string;
  readonly cookie: string;
  /** The name this side claims. Default `posipaki@<host>`, which is short enough for a `-sname` node. */
  readonly self?: string;
  /** Bits 32-63 and 0-31 of the flags word this side offers, in the order the wire writes them. */
  readonly flags?: readonly [high: number, low: number];
  /** This node's incarnation. The caller keeps it: every pid it writes afterwards has to carry the same value. */
  readonly creation: number;
  readonly timeoutMs?: number;
}

/** A connection, once the cookie is proved both ways. */
export interface Connection {
  /** The messages, from here on speaking the node's own vocabulary. */
  readonly messages: Channel<WireMessage>;
  /** What the node called itself in its challenge. */
  readonly peer: Peer;
  /** The port the connection came up on. */
  readonly port: number;
}

/** A connection to the node epmd knows as `node` on `host`. */
export async function connect(options: ConnectionOptions): Promise<Connection> {
  const port = await epmdPort(await socketChannel({ host: options.host, port: EPMD_PORT }), {
    host: options.host,
    name: options.node,
  });
  return open(port, options);
}

/** A connection to a node listening on `port`, which is what a caller that already knows where it is wants. */
export async function open(port: number, options: ConnectionOptions): Promise<Connection> {
  const frames = wrapEpmdFrame(await socketChannel({ host: options.host, port }));
  const messages = withMeaning(frames);
  const peer = await initiate(
    { frames, messages },
    {
      self: options.self ?? `posipaki@${options.host}`,
      cookie: options.cookie,
      flags: options.flags ?? MANDATORY_FLAGS,
      creation: options.creation,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  );
  return { messages, peer, port };
}
