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
import { handshake, type Peer } from "./handshake.js";
import { withMeaning, type WireMessage } from "./messages.js";

const EPMD_PORT = 4369;

/** How long a step of the connection may take when the caller says nothing. */
const DEFAULT_TIMEOUT_MS = 10_000;

// dist.h's DFLAG_DIST_MANDATORY_25 and DFLAG_UNLINK_ID: a node refuses a connection that lacks any of them. The
// flags word is sixty-four bits, written high half first, so the two are not one number here.
const DEFAULT_FLAGS: readonly [high: number, low: number] = [
  0x4,
  0x4 | 0x10 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x10000 | 0x20000 | 0x40000 | 0x1000000 | 0x2000000,
];

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
  const peer = await handshake(
    { frames, messages },
    {
      self: options.self ?? `posipaki@${options.host}`,
      cookie: options.cookie,
      flags: options.flags ?? DEFAULT_FLAGS,
      creation: options.creation,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  );
  return { messages, peer, port };
}
