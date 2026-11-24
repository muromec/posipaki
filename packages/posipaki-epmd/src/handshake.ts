// ── the handshake ───────────────────────────────────────────────────────────
//
// Name, status, challenge, two digests — and the point where the wire widens. The handshake is the only place that
// knows both phases, so `use(4)` belongs here: the ack is the last message with a two-byte length.
//
// The cookie is never sent. Each side hashes the other's challenge with it, so a node that knows a different
// cookie computes a different digest. erts says nothing when a digest is wrong — it drops the connection — so a
// connection that ends at that step is the only evidence, and the sentence names what it means.

import { createHash, randomBytes } from "node:crypto";

import type { Channel } from "posipaki/port";

import type { Framed } from "./frame.js";

import { inbox, type WireMessage } from "./messages.js";

/** What the handshake talks over: the messages, and the framing it widens at its end. */
export interface HandshakePorts {
  readonly messages: Channel<WireMessage>;
  readonly frames: Framed;
}

export interface HandshakeOptions {
  /** The name this side claims: `name@host`, with no dot in the host for a short-name node. */
  readonly self: string;
  readonly cookie: string;
  /** Bits 32-63 and 0-31 of the flags word this side offers, in the order the wire writes them. */
  readonly flags: readonly [high: number, low: number];
  /** This node's incarnation, which every pid it writes carries. */
  readonly creation: number;
  readonly timeoutMs: number;
}

/** What the node on the other end calls itself, and the incarnation it said this is. */
export interface Peer {
  readonly name: string;
  /** The incarnation: a pid minted by another one of these is a pid for a node that is not here any more. */
  readonly creation: number;
  /** The flags it offered, high half then low. */
  readonly flags: readonly [high: number, low: number];
}

/** md5 over the cookie and the challenge written as decimal text. */
export function digest(cookie: string, challenge: number): Buffer {
  return createHash("md5")
    .update(cookie + String(challenge), "utf8")
    .digest();
}

/**
 * Names this side, proves the cookie both ways, and widens the wire.
 *
 * Answers the name the other node answered with. A status the node refuses with is thrown as that status; a
 * connection that ends where a digest belonged is thrown as the cookie being wrong.
 */
export async function initiate(ports: HandshakePorts, options: HandshakeOptions): Promise<Peer> {
  const { messages, frames } = ports;
  const heard = inbox(messages);
  await messages.send({
    kind: "name",
    flags: options.flags,
    creation: options.creation,
    name: options.self,
  });

  // A node may answer with more than one status — `alive` asks this side to say whether it takes the connection
  // over — so read until something that is not a status arrives.
  let message = await heard.next(options.timeoutMs, "no status from the node");
  while (message.kind === "status") {
    if (message.status === "ok" || message.status === "ok_simultaneous") {
      message = await heard.next(options.timeoutMs, "no challenge");
      continue;
    }
    if (message.status === "alive") {
      // A connection from this node name is still registered there: this one replaces it.
      await messages.send({ kind: "status", status: "true" });
      message = await heard.next(options.timeoutMs, "no challenge after our status");
      continue;
    }
    throw new Error(`the node refused the handshake: ${message.status}`);
  }
  const challenge = message;
  if (challenge.kind !== "challenge") {
    throw new Error(`the node sent a ${challenge.kind} where its challenge belonged`);
  }

  const ours = randomBytes(4).readUInt32BE(0);
  let ack: WireMessage;
  try {
    await messages.send({
      kind: "reply",
      challenge: ours,
      digest: digest(options.cookie, challenge.challenge),
    });
    ack = await heard.next(options.timeoutMs, "no answer to our digest");
  } catch (error) {
    // erts sends nothing when the digest is wrong: it drops the connection, which is what a node that went away
    // looks like from here, and a send of our own may be the write that finds either one out.
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the connection ended at the digest: ${challenge.name} does not know this cookie, ` +
        `or went away before ours was read (${why})`,
    );
  }
  if (ack.kind !== "ack") {
    throw new Error(`the node sent a ${ack.kind} where its digest belonged`);
  }
  if (!Buffer.from(ack.digest).equals(digest(options.cookie, ours))) {
    throw new Error("the node's digest does not match ours: the cookie is not the one it knows");
  }

  // The ack is the handshake's last message, and with it the wire switches to four-byte lengths.
  frames.use(4);
  return { name: challenge.name, creation: challenge.creation, flags: challenge.flags };
}

/**
 * The accepting side: reads the name, asks a challenge of its own, checks the digest the other side computed with
 * the cookie, and proves its own with the challenge that came back.
 *
 * The widening is the same as the initiating side's: the ack is the last message either way.
 */
export async function accept(ports: HandshakePorts, options: HandshakeOptions): Promise<Peer> {
  const { messages, frames } = ports;
  const heard = inbox(messages);

  const named = await heard.next(options.timeoutMs, "no name from the node");
  if (named.kind !== "name") {
    throw new Error(`the node sent a ${named.kind} where its name belonged`);
  }

  await messages.send({ kind: "status", status: "ok" });

  const ours = randomBytes(4).readUInt32BE(0);
  await messages.send({
    kind: "challenge",
    flags: options.flags,
    challenge: ours,
    creation: options.creation,
    name: options.self,
  });

  const reply = await heard.next(options.timeoutMs, "no answer to our challenge");
  if (reply.kind !== "reply") {
    throw new Error(`the node sent a ${reply.kind} where its digest belonged`);
  }
  if (!Buffer.from(reply.digest).equals(digest(options.cookie, ours))) {
    throw new Error("the node's digest does not match ours: it does not know the cookie");
  }

  // Our own proof, over the challenge it sent: with this the cookie is proved in both directions.
  await messages.send({ kind: "ack", digest: digest(options.cookie, reply.challenge) });
  frames.use(4);
  return { name: named.name, creation: named.creation, flags: named.flags };
}

/**
 * The flags this side offers: dist.h's `DFLAG_DIST_MANDATORY` (everything a node refuses a connection without), the two
 * a monitor needs, and nothing else.
 *
 * `DFLAG_DIST_MONITOR` (`0x08`) is what makes a node send `DOP_MONITOR_P` rather than fall back to a link this side
 * cannot answer; `DFLAG_DIST_MONITOR_NAME` (`0x20`) is what lets a watch name a registered process.
 */
export const MANDATORY_FLAGS: readonly [high: number, low: number] = [
  0x4,
  0x4 |
    0x8 |
    0x10 |
    0x20 |
    0x80 |
    0x100 |
    0x200 |
    0x400 |
    0x800 |
    0x10000 |
    0x20000 |
    0x40000 |
    0x1000000 |
    0x2000000,
];

/** How long a handshake step waits when the caller does not say. */
export const DEFAULT_TIMEOUT_MS = 10_000;
