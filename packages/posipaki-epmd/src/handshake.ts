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

/** What the node on the other end calls itself. */
export interface Peer {
  readonly name: string;
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
export async function handshake(ports: HandshakePorts, options: HandshakeOptions): Promise<Peer> {
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
  await messages.send({
    kind: "reply",
    challenge: ours,
    digest: digest(options.cookie, challenge.challenge),
  });

  let ack: WireMessage;
  try {
    ack = await heard.next(options.timeoutMs, "no answer to our digest");
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the node dropped the connection at the digest: the cookie is not the one it knows (${why})`,
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
  return { name: challenge.name };
}
