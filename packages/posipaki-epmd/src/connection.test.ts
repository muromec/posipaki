// ── a connection to a node ─────────────────────────────────────────────────
//
// A node on a real socket: the test listens, answers the handshake in frames, and answers a message with the text it
// was sent. Every layer flies here — the socket, the framing, the meaning, the handshake and the control message —
// and nothing is faked but the node itself.

import { afterEach, describe, expect, it } from "vitest";

import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import { streamChannel } from "posipaki/port";

import { open } from "./connection.js";
import { wrapEpmdFrame } from "./frame.js";
import { decode, encode } from "./messages.js";
import type { Term } from "./terms.js";
import type { WireMessage } from "./messages.js";

const COOKIE = "pocookie";
const PEER_CHALLENGE = 0x0bad_c0de;
const PEER = { name: "robot@tomato", creation: 0x0a0b_0c0d, flags: [0x4, 0x1] as [number, number] };

const md5 = (cookie: string, challenge: number): Buffer =>
  createHash("md5")
    .update(cookie + String(challenge), "utf8")
    .digest();

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** The node's end: it answers the handshake, then answers `<<"hello ", Text>>` to whatever it is sent. */
function serveNode(onSocket: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    sockets.push(socket);
    onSocket(socket);
  });
  servers.push(server);
  return new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the server did not bind to a port"));
        return;
      }
      resolve(address.port);
    });
  });
}

/** One connection's worth of node: the handshake, and one answer to one message. */
function node(socket: Socket): void {
  const frames = wrapEpmdFrame(streamChannel({ read: socket, write: socket }));
  frames.onFrame((frame) => {
    void (async () => {
      if (frame[0] === 0x4e) {
        if (decode(frame, "acceptor").kind !== "name") return;
        await frames.send(encode({ kind: "status", status: "ok" }));
        await frames.send(
          encode({
            kind: "challenge",
            flags: PEER.flags,
            challenge: PEER_CHALLENGE,
            creation: PEER.creation,
            name: PEER.name,
          }),
        );
        return;
      }
      if (frame[0] === 0x72) {
        const challenge = Buffer.from(frame).readUInt32BE(1);
        await frames.send(encode({ kind: "ack", digest: md5(COOKIE, challenge) }));
        frames.use(4);
        return;
      }
      if (frame[0] !== 0x70) return;
      const said = decode(frame);
      if (said.kind !== "message" || said.payload === null || said.payload.kind !== "tuple") return;
      const [from, text] = said.payload.items;
      if (from === undefined || text === undefined || text.kind !== "binary") return;
      const answer = Buffer.concat([Buffer.from("hello ", "utf8"), Buffer.from(text.bytes)]);
      await frames.send(
        encode({
          kind: "message",
          control: { kind: "send", to: from },
          payload: { kind: "binary", bytes: answer },
        }),
      );
    })();
  });
}

/** A message to whatever is registered under `name`, from a process of ours. */
function toName(name: string, text: string, creation: number): WireMessage {
  const ourPid: Term = { kind: "pid", node: "posipaki@127.0.0.1", id: 1, serial: 0, creation };
  return {
    kind: "message",
    control: { kind: "regSend", from: ourPid, to: name },
    payload: { kind: "tuple", items: [ourPid, { kind: "binary", bytes: Buffer.from(text, "utf8") }] },
  };
}

/** The first answer, as text. */
function answer(messages: { onFrame(handler: (message: WireMessage) => void): () => void }): Promise<string> {
  return new Promise<string>((resolve) => {
    const stop = messages.onFrame((message) => {
      if (message.kind !== "message" || message.payload?.kind !== "binary") return;
      stop();
      resolve(Buffer.from(message.payload.bytes).toString("utf8"));
    });
  });
}

describe("open", () => {
  it("proves the cookie, carries a message to a name, and brings the answer back", async () => {
    const port = await serveNode(node);
    const connection = await open(port, { host: "127.0.0.1", node: "robot", cookie: COOKIE, creation: 7 });
    expect(connection.peer).toMatchObject({ name: "robot@tomato" });
    const said = answer(connection.messages);
    await connection.messages.send(toName("robot", "robot", 7));
    expect(await said).toBe("hello robot");
    await connection.messages.close("done");
  });

  it("sends the text it was given, and the node answers with exactly that", async () => {
    const port = await serveNode(node);
    const connection = await open(port, { host: "127.0.0.1", node: "robot", cookie: COOKIE, creation: 7 });
    const said = answer(connection.messages);
    await connection.messages.send(toName("echo", "probe", 7));
    expect(await said).toBe("hello probe");
    await connection.messages.close("done");
  });

  it("refuses a connection the node drops at the digest", async () => {
    const port = await serveNode((socket) => {
      const frames = wrapEpmdFrame(streamChannel({ read: socket, write: socket }));
      frames.onFrame((frame) => {
        void (async () => {
          if (frame[0] === 0x4e) {
            await frames.send(encode({ kind: "status", status: "ok" }));
            await frames.send(
              encode({
                kind: "challenge",
                flags: PEER.flags,
                challenge: PEER_CHALLENGE,
                creation: PEER.creation,
                name: PEER.name,
              }),
            );
          }
          if (frame[0] === 0x72) socket.destroy();
        })();
      });
    });
    await expect(
      open(port, { host: "127.0.0.1", node: "robot", cookie: "another cookie", creation: 7, timeoutMs: 500 }),
    ).rejects.toThrow(/the cookie is not the one it knows/);
  });
});
