// ── what a frame says ───────────────────────────────────────────────────────
//
// The first octet says which message it is: 's' a status, 'N' a node's name or, on the accepting side, the
// challenge that goes with it, 'r' a challenge reply, 'a' an ack, and 'p' the pass-through byte that begins a
// distribution message. One decode serves the handshake and everything after it.
//
// 'N' is the one message the octets do not tell apart: send_name and send_challenge carry the same tag and the
// same eight flag octets, and a node tells them apart by which side asked. This module is a client's reading, so
// an 'N' that arrives is a challenge to the side that opened the connection and a name to the side that answered,
// so the reading is a parameter and not a second function.
//
// Each term on this wire carries its own version magic, which is why a distribution message is a pass-through
// byte and a term, and why its payload is a second term with a magic of its own.

import { mapChannel, SKIP, type Channel } from "posipaki/port";

import { readControl, writeControl, type Control } from "./control.js";
import { TermReader, write, type Term } from "./terms.js";
import { withTimeout } from "./timeout.js";

/** The byte ei writes before a distribution message: no atom cache, no fragments, just the term. */
const PASS_THROUGH = 0x70;
/** The version magic that begins every term. */
const VERSION = 131;

const TAG_STATUS = 0x73; // 's'
const TAG_NAME = 0x4e; // 'N'
const TAG_REPLY = 0x72; // 'r'
const TAG_ACK = 0x61; // 'a'

/** How a node names itself: the flags it offers, the incarnation it was born with, and what it answers to. */
export interface NodeIdentity {
  readonly flags: readonly [number, number];
  readonly creation: number;
  readonly name: string;
}

/** One message of the wire, as this side reads or writes it. */
export type WireMessage =
  | ({ readonly kind: "name" } & NodeIdentity)
  | ({ readonly kind: "challenge"; readonly challenge: number } & NodeIdentity)
  | { readonly kind: "status"; readonly status: string }
  | { readonly kind: "reply"; readonly challenge: number; readonly digest: Uint8Array }
  | { readonly kind: "ack"; readonly digest: Uint8Array }
  | { readonly kind: "message"; readonly control: Control; readonly payload: Term | null };

/** The octets of a frame as bytes a reader can index. */
function bytes(frame: Uint8Array): Buffer {
  return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
}

function flagsOf(body: Buffer): [number, number] {
  return [body.readUInt32BE(1), body.readUInt32BE(5)];
}

/** The name whose length sits at `start`, in the two octets before it. */
function nameAt(body: Buffer, start: number): string {
  const length = body.readUInt16BE(start);
  return body.subarray(start + 2, start + 2 + length).toString("utf8");
}

/** Which side of a connection is reading. The name and the challenge are the same message, told apart by this. */
export type Side = "initiator" | "acceptor";

/** What a frame says, read as `side` reads it: an 'N' is a challenge to the side that opened the connection. */
export function decode(frame: Uint8Array, side: Side = "initiator"): WireMessage {
  const body = bytes(frame);
  if (body.length === 0) {
    throw new Error("a frame carried nothing: every message on this wire begins with the byte that names it");
  }
  switch (body[0]) {
    case TAG_STATUS:
      return { kind: "status", status: body.subarray(1).toString("utf8") };
    case TAG_NAME:
      // The same octets, read by the side that asked the question or the side that answered it.
      return side === "acceptor"
        ? {
            kind: "name",
            flags: flagsOf(body),
            creation: body.readUInt32BE(9),
            name: nameAt(body, 13),
          }
        : {
            kind: "challenge",
            flags: flagsOf(body),
            challenge: body.readUInt32BE(9),
            creation: body.readUInt32BE(13),
            name: nameAt(body, 17),
          };
    case TAG_REPLY:
      return { kind: "reply", challenge: body.readUInt32BE(1), digest: body.subarray(5, 21) };
    case TAG_ACK:
      return { kind: "ack", digest: body.subarray(1, 17) };
    case PASS_THROUGH: {
      if (body[1] !== VERSION) {
        throw new Error(`a distribution message carried ${body[1]}, not the term format's ${VERSION}`);
      }
      const terms = new TermReader(body.subarray(2));
      if (terms.done()) throw new Error("a distribution message carried no control message");
      const control = readControl(terms.term());
      if (terms.done()) return { kind: "message", control, payload: null };
      if (terms.peek() !== VERSION) {
        throw new Error(`the message after a control began with ${terms.peek()}, not ${VERSION}`);
      }
      terms.skip(1);
      return { kind: "message", control, payload: terms.term() };
    }
    default:
      throw new Error(`the first byte ${body[0]} names no message this script reads`);
  }
}


/** The octets of a message. */
export function encode(message: WireMessage): Uint8Array {
  switch (message.kind) {
    case "status":
      return Buffer.concat([Buffer.from([TAG_STATUS]), Buffer.from(message.status, "utf8")]);
    case "name":
    case "challenge": {
      const name = Buffer.from(message.name, "utf8");
      const challenge = message.kind === "challenge";
      const head = Buffer.alloc(challenge ? 19 : 15);
      head[0] = TAG_NAME;
      head.writeUInt32BE(message.flags[0], 1);
      head.writeUInt32BE(message.flags[1], 5);
      if (message.kind === "challenge") {
        head.writeUInt32BE(message.challenge, 9);
        head.writeUInt32BE(message.creation, 13);
        head.writeUInt16BE(name.length, 17);
      } else {
        head.writeUInt32BE(message.creation, 9);
        head.writeUInt16BE(name.length, 13);
      }
      return Buffer.concat([head, name]);
    }
    case "reply": {
      const head = Buffer.alloc(21);
      head[0] = TAG_REPLY;
      head.writeUInt32BE(message.challenge, 1);
      Buffer.from(message.digest).copy(head, 5);
      return head;
    }
    case "ack": {
      const head = Buffer.alloc(17);
      head[0] = TAG_ACK;
      Buffer.from(message.digest).copy(head, 1);
      return head;
    }
    case "message": {
      const parts = [Buffer.from([PASS_THROUGH, VERSION]), write(writeControl(message.control))];
      if (message.payload !== null) parts.push(Buffer.from([VERSION]), write(message.payload));
      return Buffer.concat(parts);
    }
  }
}


/**
 * A channel of frames as a channel of messages: this side's reading, both ways.
 *
 * A frame this side cannot read is not the process's death: it is complained about, loudly, and the connection
 * carries on. The alternative — throwing out of the frame callback — lands in the socket's own read loop, where an
 * uncaught exception takes down a process that has nothing to do with the peer that sent it.
 */
export function withMeaning<C = string>(
  frames: Channel<Uint8Array, C>,
  side: Side = "initiator",
  onBadFrame: (error: Error, frame: Uint8Array) => void = complainedAbout,
): Channel<WireMessage, C> {
  return mapChannel(frames, encode, (frame) => {
    try {
      return decode(frame, side);
    } catch (error) {
      onBadFrame(error instanceof Error ? error : new Error(String(error)), frame);
      return SKIP;
    }
  });
}

/** What a frame nobody can read is told: the first octets it began with, and why. */
function complainedAbout(error: Error, frame: Uint8Array): void {
  const seen = [...frame.subarray(0, 8)].map((octet) => octet.toString(16).padStart(2, "0")).join(" ");
  console.error(`epmd: a frame of ${frame.length} octets could not be read (${seen}): ${error.message}`);
}
/**
 * The messages as they arrive.
 *
 * A node may answer before this side asks for the answer — a memory pair delivers before `send` settles, and a
 * fast node does the same over a socket — so the reader is subscribed once, and what arrives waits here.
 */
export function inbox(messages: Channel<WireMessage>) {
  const standing: WireMessage[] = [];
  const readers: Array<(message: WireMessage) => void> = [];
  const refused: Array<(error: Error) => void> = [];
  let closed: string | null = null;

  messages.onFrame((message) => {
    const reader = readers.shift();
    if (reader !== undefined) reader(message);
    else standing.push(message);
  });
  messages.onClose((reason) => {
    closed = reason;
    for (const refuse of refused.splice(0)) refuse(new Error(reason));
  });

  return {
    /** The next message, or a sentence when the node says nothing and the bound runs out. */
    next(timeoutMs: number, reason: string): Promise<WireMessage> {
      const waiting = standing.shift();
      if (waiting !== undefined) return Promise.resolve(waiting);
      if (closed !== null) return Promise.reject(new Error(closed));
      const awaited = new Promise<WireMessage>((resolve, reject) => {
        readers.push(resolve);
        refused.push(reject);
      });
      // A reader that timed out is gone; whatever the channel says to it afterwards is nobody's news.
      awaited.catch(() => undefined);
      return withTimeout(awaited, timeoutMs, reason);
    },
  };
}
