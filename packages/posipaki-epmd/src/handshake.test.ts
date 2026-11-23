// ── the handshake ──────────────────────────────────────────────────────────
//
// A node on the other end of a memory pair, scripted in frames: what it answers is what a real node answers, so
// the side under test is the side that has to be right. Nothing is faked but the medium.

import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { memoryChannelPair } from "posipaki/port";

import { wrapEpmdFrame } from "./frame.js";
import { handshake, type HandshakeOptions } from "./handshake.js";
import { decode, decodeName, encode, withMeaning } from "./messages.js";

const COOKIE = "pocookie";
const PEER_CHALLENGE = 0x1122_3344;
const PEER = {
  name: "robot@tomato",
  creation: 0x0a0b_0c0d,
  flags: [0x4, 0x1] as [number, number],
};

const md5 = (cookie: string, challenge: number): Buffer =>
  createHash("md5")
    .update(cookie + String(challenge), "utf8")
    .digest();

const challenge = (): Uint8Array =>
  encode({
    kind: "challenge",
    flags: PEER.flags,
    challenge: PEER_CHALLENGE,
    creation: PEER.creation,
    name: PEER.name,
  });

interface Script {
  /** What the node answers the name with. `alive` asks for a status in reply before the challenge. */
  readonly status?: string;
  /** The cookie the node believes in. */
  readonly cookie?: string;
  /** End the connection where the ack belonged, as erts does for a digest it does not accept. */
  readonly hangUp?: boolean;
  /** Ack with the digest of another cookie. */
  readonly wrongAck?: boolean;
}

/** Both ends of one pair: this side's framing and messages, and the node's script. */
function connection(script: Script) {
  const ends = memoryChannelPair<Uint8Array>();
  const frames = wrapEpmdFrame(ends.near);
  const peer = wrapEpmdFrame(ends.far);
  const claimed: string[] = [];
  const cookie = script.cookie ?? COOKIE;

  const answer = async (frame: Uint8Array): Promise<void> => {
    if (frame[0] === 0x4e) {
      const identity = decodeName(frame);
      if (identity !== null) claimed.push(identity.name);
      const status = script.status ?? "ok";
      await peer.send(encode({ kind: "status", status }));
      if (status === "ok") await peer.send(challenge());
      return;
    }
    if (frame[0] === 0x73) {
      // Our answer to `alive`: the challenge follows it.
      await peer.send(challenge());
      return;
    }
    if (frame[0] === 0x72) {
      const reply = decode(frame);
      if (reply.kind !== "reply") return;
      if (script.hangUp === true) {
        await ends.far.close("the far end closed");
        return;
      }
      const digest = script.wrongAck === true ? md5("another cookie", reply.challenge) : md5(cookie, reply.challenge);
      await peer.send(encode({ kind: "ack", digest }));
    }
  };

  peer.onFrame((frame) => {
    void answer(frame);
  });
  return { frames, messages: withMeaning(frames), claimed: () => claimed };
}

function options(overrides: Partial<HandshakeOptions> = {}): HandshakeOptions {
  return {
    self: "posipaki@host",
    cookie: COOKIE,
    flags: [0x4, 0x3070f94],
    creation: 12_345,
    timeoutMs: 2_000,
    ...overrides,
  };
}

describe("handshake", () => {
  it("answers with the node's name, and widens the wire to four-byte lengths", async () => {
    const { frames, messages, claimed } = connection({});
    const peer = await handshake({ frames, messages }, options());
    expect(peer).toEqual({ name: "robot@tomato" });
    expect(frames.prefix).toBe(4);
    expect(claimed()).toEqual(["posipaki@host"]);
  });

  it("refuses the handshake with the status the node gave", async () => {
    const { frames, messages } = connection({ status: "not_allowed" });
    await expect(handshake({ frames, messages }, options())).rejects.toThrow(
      "the node refused the handshake: not_allowed",
    );
  });

  it("takes `alive` as a question, answers it, and carries on", async () => {
    const { frames, messages } = connection({ status: "alive" });
    const peer = await handshake({ frames, messages }, options());
    expect(peer).toEqual({ name: "robot@tomato" });
    expect(frames.prefix).toBe(4);
  });

  it("names a wrong cookie as the connection ending at the digest", async () => {
    const { frames, messages } = connection({ hangUp: true });
    await expect(handshake({ frames, messages }, options({ timeoutMs: 200 }))).rejects.toThrow(
      /the cookie is not the one it knows/,
    );
  });

  it("refuses a node whose own digest does not match", async () => {
    const { frames, messages } = connection({ wrongAck: true });
    await expect(handshake({ frames, messages }, options())).rejects.toThrow(
      "the node's digest does not match ours",
    );
  });
});
