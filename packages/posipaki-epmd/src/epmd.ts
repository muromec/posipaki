// ── the port mapper ─────────────────────────────────────────────────────────
//
// epmd says where a node listens. The request is framed like every message before the handshake — a two-byte
// length — and the answer is not framed at all: it is the octets epmd sends before it closes the socket. That is
// why this sits beside the frame layer rather than on top of it: one packet on this wire announces no length.

import { createServer, type Socket } from "node:net";

import type { Channel } from "posipaki/port";
import { socketChannel } from "posipaki/port/node";

const PORT2_REQ = 122;
const PORT2_RESP = 119;

/** Which node, at which host: both are needed for the sentences a refusal is made of. */
export interface Lookup {
  readonly host: string;
  readonly name: string;
}

/** Asks the port mapper on `host` which port the node called `name` listens on. */
export async function epmdPort(channel: Channel<Uint8Array>, lookup: Lookup): Promise<number> {
  const asked = Buffer.concat([Buffer.from([PORT2_REQ]), Buffer.from(lookup.name, "utf8")]);
  const head = Buffer.alloc(2);
  head.writeUInt16BE(asked.length, 0);

  const chunks: Buffer[] = [];
  const answered = new Promise<Buffer>((resolve, reject) => {
    channel.onFrame((chunk) => {
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    channel.onClose(() => resolve(Buffer.concat(chunks)));
    channel.onError((error) => reject(error instanceof Error ? error : new Error(String(error))));
  });

  await channel.send(new Uint8Array(Buffer.concat([head, asked])));
  const reply = await answered;

  if (reply.length < 2) {
    throw new Error(`epmd on ${lookup.host} answered ${reply.length} bytes and nothing else`);
  }
  if (reply[0] !== PORT2_RESP) {
    throw new Error(`epmd answered request ${reply[0]}, not ${PORT2_RESP}`);
  }
  // A refusal is the tag and a reason, and nothing else.
  const result = reply[1];
  if (result !== 0) {
    throw new Error(`epmd on ${lookup.host} does not know a node named ${lookup.name} (result ${result})`);
  }
  if (reply.length < 4) {
    throw new Error(`epmd on ${lookup.host} named a port in ${reply.length} bytes`);
  }
  return reply.readUInt16BE(2);
}

// ── the mapper on this host ────────────────────────────────────────────────
//
// A node that listens is reachable only if something answers "where does <name> listen" at its address, which is
// what epmd is for. This is that server for one host: a node registers when it starts (ALIVE2, and the connection
// stays open for as long as the registration lasts) and another node asks (PORT2) where it went.
//
// A registration dies with its connection, as it does on a real epmd: a node that stops is a socket that closes.

const ALIVE2_REQ = 120;
const ALIVE2_X_RESP = 118;

/** The port a mapper listens on, on any host this protocol talks to. */
const EPMD_PORT = 4369;

/**
 * A mapper's port that a process already holds.
 *
 * A node's policy decides what that means: `start: "never"` reports it, `"auto"` reads it as another mapper answering
 * at that port and registers there.
 */
export class MapperPortTaken extends Error {
  constructor(port: number) {
    super(`a mapper cannot bind ${port}: the port is in use, which is what another mapper on this host looks like`);
    this.name = "MapperPortTaken";
  }
}

/** Whether a mapper answers at `host:port`: a connection opened and let go without asking it anything. */
export async function mapperAnswers(host: string, port: number = EPMD_PORT): Promise<boolean> {
  try {
    const channel = await socketChannel({ host, port });
    await channel.close("a probe").catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** The node type a hidden node registers with: it is in the mesh, not in the global namespace. */
const NODE_TYPE_HIDDEN = 72;
const PROTOCOL_TCP_IPV4 = 0;
const HIGHEST_VERSION = 6;
const LOWEST_VERSION = 5;

/** What a node needs of the mapper on its host. */
export interface Mapper {
  /** The port the mapper answers on. */
  readonly port: number;
  /** Where a name is: read when a node asks, so a registration is one call and no state of its own. */
  find(name: string): number | null;
  close(): Promise<void>;
}

/** Reads a 2-byte-length request off a socket, once. */
function request(socket: Socket): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer | null>((resolve) => {
    const done = (): void => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onClose);
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      if (all.length < 2) return;
      const length = all.readUInt16BE(0);
      if (all.length < 2 + length) return;
      done();
      resolve(all.subarray(2, 2 + length));
    };
    const onClose = (): void => {
      done();
      resolve(null);
    };
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onClose);
  });
}

/** The answer a port lookup gets: the tag, a result, the port, and what the node said about itself. */
function portReply(port: number, name: string): Buffer {
  const named = Buffer.from(name, "utf8");
  const head = Buffer.alloc(13);
  head[0] = PORT2_RESP;
  head[1] = 0;
  head.writeUInt16BE(port, 2);
  head[4] = 77; // a normal Erlang node
  head[5] = PROTOCOL_TCP_IPV4;
  head.writeUInt16BE(HIGHEST_VERSION, 6);
  head.writeUInt16BE(LOWEST_VERSION, 8);
  head.writeUInt16BE(named.length, 10);
  const extra = Buffer.alloc(2);
  return Buffer.concat([head, named, extra]);
}

/**
 * A port mapper for this host.
 *
 * It is not a full epmd: it answers the two requests a node makes of its host's mapper — where does a name listen,
 * and this node is here — and nothing else. `find` is for the process that runs it, so a node in the same program
 * needs no socket to register.
 */
export async function serveEpmd(port = 4369): Promise<Mapper> {
  const names = new Map<string, number>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    void (async () => {
      const asked = await request(socket);
      if (asked === null || asked.length === 0) {
        socket.destroy();
        return;
      }
      if (asked[0] === PORT2_REQ) {
        const name = asked.subarray(1).toString("utf8");
        const found = names.get(name);
        socket.write(found === undefined ? new Uint8Array([PORT2_RESP, 1]) : portReply(found, name));
        socket.end();
        return;
      }
      if (asked[0] === ALIVE2_REQ) {
        // 120, PortNo:16, NodeType, Protocol, Highest:16, Lowest:16, Nlen:16, Name, Elen:16, Extra
        const registered = asked.readUInt16BE(1);
        const length = asked.readUInt16BE(9);
        const name = asked.subarray(11, 11 + length).toString("utf8");
        names.set(name, registered);
        const answer = Buffer.alloc(6);
        answer[0] = ALIVE2_X_RESP;
        answer[1] = 0;
        answer.writeUInt32BE(names.size, 2); // a creation value: a count is enough to tell incarnations apart here
        socket.write(answer);
        socket.on("close", () => {
          if (names.get(name) === registered) names.delete(name);
        });
        return;
      }
      socket.destroy();
    })();
  });
  const bound = await new Promise<number>((resolve, reject) => {
    server.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new MapperPortTaken(port) : error);
    });
    server.listen(port, "0.0.0.0", () => {
      const address = server.address();
      resolve(address === null || typeof address === "string" ? port : address.port);
    });
  });
  return {
    port: bound,
    find: (name) => names.get(name) ?? null,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The first `count` octets a channel is given: epmd's answers carry no length, so the count is the caller's. */
async function firstOctets(channel: Channel<Uint8Array>, count: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const collected = new Promise<Buffer>((resolve) => {
    channel.onFrame((chunk) => {
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      const all = Buffer.concat(chunks);
      if (all.length >= count) resolve(all);
    });
  });
  return collected;
}

/** A node's registration with the mapper, which lasts as long as its connection does. */
export interface Registration {
  close(): Promise<void>;
}

/**
 * Registers a node with the mapper at `host`.
 *
 * The registration is the connection: closing it is how a node says it is gone, which is what epmd means by the
 * same thing.
 */
export async function epmdRegister(options: {
  readonly host: string;
  readonly name: string;
  readonly port: number;
  readonly mapperPort?: number;
}): Promise<Registration> {
  const mapperPort = options.mapperPort ?? EPMD_PORT;
  // Nothing listening is this node's start failing, so it is said as what was missing rather than as a socket error.
  const channel = await socketChannel({ host: options.host, port: mapperPort }).catch((error: unknown) => {
    throw new Error(
      `no mapper answered at ${options.host}:${mapperPort}, which ${options.name} needs to be found: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  const named = Buffer.from(options.name, "utf8");
  const asked = Buffer.alloc(11 + named.length + 2);
  asked[0] = ALIVE2_REQ;
  asked.writeUInt16BE(options.port, 1);
  asked[3] = NODE_TYPE_HIDDEN;
  asked[4] = PROTOCOL_TCP_IPV4;
  asked.writeUInt16BE(HIGHEST_VERSION, 5);
  asked.writeUInt16BE(LOWEST_VERSION, 7);
  asked.writeUInt16BE(named.length, 9);
  named.copy(asked, 11);
  asked.writeUInt16BE(0, 11 + named.length);

  const head = Buffer.alloc(2);
  head.writeUInt16BE(asked.length, 0);
  const answered = firstOctets(channel, 6);
  await channel.send(new Uint8Array(Buffer.concat([head, asked])));
  const reply = await answered;
  if (reply.length < 6 || reply[0] !== ALIVE2_X_RESP || reply[1] !== 0) {
    await channel.close("the mapper refused the registration");
    throw new Error(`the mapper at ${options.host} refused to register ${options.name}`);
  }
  return { close: () => channel.close("the node is gone") };
}
