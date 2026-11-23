#!/usr/bin/env bun
/**
 * Sends a message to a name on an Erlang node over the distribution protocol.
 *
 * The node is found through epmd on its host, the handshake authenticates with
 * the cookie, and one DOP_REG_SEND carries the message to a registered name.
 * The answer is printed.
 *
 *   erlc robot.erl
 *   erl -sname robot -setcookie pocookie -noshell -eval 'robot:start().'
 *
 *   bun src/index.ts <host> <cookie>
 *
 * Options: --name (the registered name, robot), --self (this side's node name,
 * posipaki@<host>), --message (what to send, "robot").
 *
 * The protocol is documented in erts' Distribution Protocol guide, and the
 * flags and opcodes below carry the names erts/emulator/beam/dist.h gives them.
 * No dependencies: node:net and node:crypto only.
 */

import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

// ── the wire's constants ───────────────────────────────────────────────

const EPMD_PORT = 4369;
const EPMD_PORT2_REQ = 122;
const EPMD_PORT2_RESP = 119;

/** ei writes this byte (0x70, "p") before the version magic; erts skips whatever is there. */
const PASS_THROUGH = 0x70;
const ETF_VERSION = 131;

// dist.h's DFLAG_DIST_MANDATORY_25 and DFLAG_UNLINK_ID: a node refuses a
// connection that lacks any of them. This is the flags word's low 32 bits.
const FLAGS_LOW =
  0x4 | 0x10 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x10000 | 0x20000 |
  0x40000 | 0x1000000 | 0x2000000;

/** The flags' high word, where DFLAG_V4_NC (bit 32) lives. */
const FLAGS_HIGH = 0x4;

const DOP_SEND = 2;
const DOP_EXIT = 3;
const DOP_REG_SEND = 6;
const trace = Boolean(process.env.POSIPAKI_EPMD_TRACE);

/** How long one step waits for the peer before the script gives up. */
const TIMEOUT_MS = 10_000;

// ── a socket as bytes ──────────────────────────────────────────────────

/** Buffers a socket so a caller asks for N bytes instead of watching events. */
class Reader {
  private buffer: Buffer = Buffer.alloc(0);
  private waiting: Array<() => void> = [];
  private failure: Error | null = null;

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.on("error", (error: Error) => {
      this.failure = this.failure ?? error;
      this.wake();
    });
    socket.on("close", () => {
      this.failure = this.failure ?? new Error("the connection ended");
      this.wake();
    });
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resume of waiting) resume();
  }

  async bytes(count: number): Promise<Buffer> {
    while (this.buffer.length < count) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resume) => this.waiting.push(resume));
    }
    const head = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return head;
  }

  /** A packet with a 2-byte length: epmd, and every handshake message. */
  async packet2(): Promise<Buffer> {
    const length = await this.bytes(2);
    return this.bytes(length.readUInt16BE(0));
  }

  /** A packet with a 4-byte length: everything after the handshake. */
  async packet4(): Promise<Buffer> {
    const length = await this.bytes(4);
    return this.bytes(length.readUInt32BE(0));
  }
}

function frame2(body: Buffer): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function frame4(body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

// ── epmd: which port does the node listen on ───────────────────────────

/** Everything the peer sends before it closes. epmd's answers carry no length prefix. */
function readToClose(socket: Socket): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", (error: Error) => reject(error));
    socket.on("close", () => resolve(Buffer.concat(chunks)));
  });
}

async function distPort(host: string, name: string): Promise<number> {
  const socket = connect({ host, port: EPMD_PORT });
  const answer = readToClose(socket);
  socket.write(frame2(Buffer.concat([Buffer.from([EPMD_PORT2_REQ]), Buffer.from(name, "utf8")])));
  const reply = await answer;
  if (reply.length < 2) throw new Error(`epmd on ${host} answered ${reply.length} bytes and nothing else`);
  if (reply[0] !== EPMD_PORT2_RESP) {
    throw new Error(`epmd answered request ${reply[0]}, not ${EPMD_PORT2_RESP}`);
  }
  // A refusal is the tag and a reason, and nothing else.
  const result = reply[1];
  if (result !== 0) {
    throw new Error(`epmd on ${host} does not know a node named ${name} (result ${result})`);
  }
  if (reply.length < 4) throw new Error(`epmd on ${host} named a port in ${reply.length} bytes`);
  return reply.readUInt16BE(2);
}

// ── the handshake ──────────────────────────────────────────────────────

/**
 * md5 over the cookie and the challenge as decimal text. The cookie is
 * compared by both sides this way; nothing of it goes on the wire.
 */
function digest(cookie: string, challenge: number): Buffer {
  return createHash("md5")
    .update(cookie + String(challenge), "utf8")
    .digest();
}

interface HandshakeOptions {
  self: string;
  cookie: string;
  creation: number;
}

/** What the other node said about itself in its challenge. */
interface Peer {
  name: string;
}

async function handshake(
  socket: Socket,
  reader: Reader,
  options: HandshakeOptions,
): Promise<Peer> {
  const name = Buffer.from(options.self, "utf8");
  const hello = Buffer.alloc(15);
  hello[0] = 0x4e; // 'N': the version-6 name message
  hello.writeUInt32BE(FLAGS_HIGH, 1);
  hello.writeUInt32BE(FLAGS_LOW, 5);
  hello.writeUInt32BE(options.creation, 9);
  hello.writeUInt16BE(name.length, 13);
  socket.write(frame2(Buffer.concat([hello, name])));

  let status = await withTimeout(reader.packet2(), TIMEOUT_MS, "no status from the node");
  while (status[0] === 0x73) {
    const text = status.subarray(1).toString("utf8");
    if (text === "ok" || text === "ok_simultaneous") break;
    if (text === "alive") {
      // A connection from this node name is still registered there: say that
      // ours replaces it rather than give up.
      socket.write(frame2(Buffer.concat([Buffer.from([0x73]), Buffer.from("true")])));
      status = await withTimeout(reader.packet2(), TIMEOUT_MS, "no second status");
      continue;
    }
    throw new Error(`the node refused the handshake: ${text}`);
  }

  const challenge = await withTimeout(reader.packet2(), TIMEOUT_MS, "no challenge");
  if (challenge[0] !== 0x4e) {
    throw new Error(`the node sent ${JSON.stringify(String.fromCharCode(challenge[0]))}, not a challenge`);
  }
  const peerChallenge = challenge.readUInt32BE(9);
  const nameLength = challenge.readUInt16BE(17);
  const peer: Peer = { name: challenge.subarray(19, 19 + nameLength).toString("utf8") };

  const ourChallenge = randomBytes(4).readUInt32BE(0);
  if (trace) console.error(`challenge ${challenge.toString("hex")}`);
  const reply = Buffer.alloc(21);
  reply[0] = 0x72; // 'r'
  reply.writeUInt32BE(ourChallenge, 1);
  digest(options.cookie, peerChallenge).copy(reply, 5);
  socket.write(frame2(reply));

  let ack: Buffer;
  try {
    ack = await withTimeout(reader.packet2(), TIMEOUT_MS, "no answer to our digest");
  } catch (error) {
    // erts sends nothing when the digest is wrong: it drops the connection.
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the node dropped the connection at the digest: the cookie is not the one it knows (${why})`,
    );
  }
  if (trace) console.error(`ack ${ack.toString("hex")}`);
  if (ack[0] !== 0x61) {
    throw new Error(`the node answered ${JSON.stringify(String.fromCharCode(ack[0]))}, not a digest`);
  }
  if (!ack.subarray(1, 17).equals(digest(options.cookie, ourChallenge))) {
    throw new Error("the node's digest does not match ours: the cookie is not the one it knows");
  }
  return peer;
}

// ── the external term format, the tags this script needs ───────────────

type Term =
  | { kind: "atom"; name: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "binary"; bytes: Buffer }
  | { kind: "string"; value: string }
  | { kind: "tuple"; items: Term[] }
  | { kind: "list"; items: Term[] }
  | { kind: "map"; pairs: Array<[Term, Term]> }
  | { kind: "pid"; node: string; id: number; serial: number; creation: number }
  | { kind: "ref"; node: string };

function etfAtom(name: string): Buffer {
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length < 256) return Buffer.concat([Buffer.from([119, bytes.length]), bytes]);
  const head = Buffer.alloc(3);
  head[0] = 118; // ATOM_UTF8_EXT
  head.writeUInt16BE(bytes.length, 1);
  return Buffer.concat([head, bytes]);
}

function etfInt(value: number): Buffer {
  if (value >= 0 && value < 256) return Buffer.from([97, value]);
  const out = Buffer.alloc(5);
  out[0] = 98; // INTEGER_EXT
  out.writeInt32BE(value, 1);
  return out;
}

/** A process id on `node`, whose creation value is the one that node announced. */
function etfPid(node: string, id: number, serial: number, creation: number): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32BE(id, 0);
  body.writeUInt32BE(serial, 4);
  body.writeUInt32BE(creation, 8);
  return Buffer.concat([Buffer.from([88]), etfAtom(node), body]); // NEW_PID_EXT: node first
}

function etfBinary(data: Buffer): Buffer {
  // BINARY_EXT carries a 32-bit length whatever the size: there is no small form.
  const head = Buffer.alloc(5);
  head[0] = 109;
  head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
}

function etfTuple(items: Buffer[]): Buffer {
  if (items.length > 255) throw new Error(`a tuple of ${items.length} items has no small-tuple tag`);
  return Buffer.concat([Buffer.from([104, items.length]), ...items]);
}

/** Reads terms out of one packet, one after another. */
class TermReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  peek(): number {
    return this.offset < this.buffer.length ? this.buffer[this.offset] : -1;
  }

  skip(count: number): void {
    this.offset += count;
  }

  done(): boolean {
    return this.offset >= this.buffer.length;
  }

  term(): Term {
    const start = this.offset;
    const tag = this.u8();
    switch (tag) {
      case 97:
        return { kind: "int", value: this.u8() };
      case 98:
        return { kind: "int", value: this.i32() };
      case 70:
        return { kind: "float", value: this.f64() };
      case 100:
        return { kind: "atom", name: this.text(this.u16(), "latin1") };
      case 118:
        return { kind: "atom", name: this.text(this.u16(), "utf8") };
      case 115:
        return { kind: "atom", name: this.text(this.u8(), "utf8") };
      case 119:
        return { kind: "atom", name: this.text(this.u8(), "latin1") };
      case 104:
        return { kind: "tuple", items: this.items(this.u8()) };
      case 105:
        return { kind: "tuple", items: this.items(this.u32()) };
      case 106:
        return { kind: "list", items: [] };
      case 107:
        return { kind: "string", value: this.text(this.u16(), "latin1") };
      case 108: {
        const items = this.items(this.u32());
        const tail = this.term();
        if (tail.kind !== "list" || tail.items.length > 0) {
          throw new Error("this script reads proper lists only, and this one does not end in []");
        }
        return { kind: "list", items };
      }
      case 109:
        return { kind: "binary", bytes: this.take(this.u32()) };
      case 77: {
        const bytes = this.take(this.u32());
        const bits = this.u8();
        if (bits !== 8) {
          throw new Error(`a binary whose last byte holds ${bits} of 8 bits is not read here`);
        }
        return { kind: "binary", bytes };
      }
      case 116: {
        const pairs: Array<[Term, Term]> = [];
        for (let left = this.u32(); left > 0; left -= 1) pairs.push([this.term(), this.term()]);
        return { kind: "map", pairs };
      }
      case 88:
        return {
          kind: "pid",
          node: this.atomName(),
          id: this.u32(),
          serial: this.u32(),
          creation: this.u32(),
        };
      case 90: {
        const node = this.atomName();
        this.u32();
        this.u32();
        return { kind: "ref", node };
      }
      case 114:
      case 101: {
        const ids = this.u16();
        const node = this.atomName();
        this.u32();
        for (let left = ids; left > 0; left -= 1) this.u32();
        return { kind: "ref", node };
      }
      default:
        throw new Error(`the term format tag ${tag} at byte ${start} is not read by this script`);
    }
  }

  private items(count: number): Term[] {
    const items: Term[] = [];
    for (let index = 0; index < count; index += 1) items.push(this.term());
    return items;
  }

  private atomName(): string {
    const atom = this.term();
    if (atom.kind !== "atom") throw new Error(`a node name was a ${atom.kind}, not an atom`);
    return atom.name;
  }

  private u8(): number {
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  private u16(): number {
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  private u32(): number {
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  private i32(): number {
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  private f64(): number {
    const value = this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }

  private take(count: number): Buffer {
    const slice = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  private text(count: number, encoding: BufferEncoding): string {
    return this.take(count).toString(encoding);
  }
}

function render(term: Term): string {
  switch (term.kind) {
    case "atom":
      return term.name;
    case "int":
    case "float":
      return String(term.value);
    case "binary":
      return term.bytes.toString("utf8");
    case "string":
      return term.value;
    case "tuple":
      return `{${term.items.map(render).join(", ")}}`;
    case "list":
      return `[${term.items.map(render).join(", ")}]`;
    case "map":
      return `#{${term.pairs.map(([key, value]) => `${render(key)} => ${render(value)}`).join(", ")}}`;
    case "pid":
      return `#PID<${term.node}.${term.id}.${term.serial}>`;
    case "ref":
      return `#Ref<${term.node}>`;
  }
}

/** Resolves with the work, or rejects after `ms` with `reason`. */
function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Reads packets until one carries a message for a process of ours. */
async function firstMessage(reader: Reader): Promise<Term> {
  for (;;) {
    const packet = await reader.packet4();
    if (trace) console.error(`received ${packet.toString("hex")}`);
    if (packet.length === 0) continue; // a tick, not a signal
    // No atom cache and no fragments are negotiated here, so erts prefixes every
    // message with one pass-through byte before the term format's magic.
    const body = packet[0] === PASS_THROUGH ? packet.subarray(1) : packet;
    if (body[0] !== ETF_VERSION) {
      throw new Error(`a packet carried ${body[0]} where the term format's ${ETF_VERSION} belongs`);
    }
    const terms = new TermReader(body.subarray(1));
    if (terms.done()) continue;
    const control = terms.term();
    if (control.kind !== "tuple" || control.items.length === 0) {
      throw new Error(`a control message was not a tuple: ${render(control)}`);
    }
    const head = control.items[0];
    if (head.kind !== "int") throw new Error(`a control message began with a ${head.kind}, not an opcode`);
    if (head.value === DOP_SEND || head.value === DOP_REG_SEND) {
      // The message term carries its own version magic, after the control's.
      if (terms.peek() === ETF_VERSION) terms.skip(1);
      if (!terms.done()) return terms.term();
      continue;
    }
    if (head.value === DOP_EXIT) {
      const reason = control.items[3];
      throw new Error(`the node closed the connection: ${reason ? render(reason) : "no reason given"}`);
    }
    // A link, a monitor, a group leader: not this script's business, and its
    // payload (if any) is not a message.
  }
}

interface Options {
  host: string;
  cookie: string;
  name: string;
  self: string;
  message: string;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${item} needs a value`);
      flags[item.slice(2)] = value;
      index += 1;
    } else {
      positional.push(item);
    }
  }
  const [host, cookie] = positional;
  if (host === undefined || cookie === undefined) {
    throw new Error(
      "usage: posipaki-epmd <host> <cookie> [--name robot] [--self posipaki@<host>] [--message robot]",
    );
  }
  return {
    host,
    cookie,
    name: flags.name ?? "robot",
    // A short node name carries no dot, so the default takes the peer's host:
    // a node started with -sname refuses a name that looks like a long one.
    self: flags.self ?? `posipaki@${host}`,
    message: flags.message ?? "robot",
  };
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const port = await distPort(options.host, options.name);
  const socket = connect({ host: options.host, port });
  const reader = new Reader(socket);
  const creation = randomBytes(4).readUInt32BE(0) || 1;
  const peer = await handshake(socket, reader, {
    self: options.self,
    cookie: options.cookie,
    creation,
  });
  console.log(`${peer.name} at ${options.host}:${port}`);

  // Our own process id, so the other side has somewhere to answer. Nothing here
  // holds it: a pid is an address this connection carries.
  const ourselves = etfPid(options.self, 1, 0, creation);

  // {DOP_REG_SEND, FromPid, Cookie, ToName}: four elements, and the Cookie slot
  // has been the empty atom since R9B — erts does not look at it.
  const control = etfTuple([etfInt(DOP_REG_SEND), ourselves, etfAtom(""), etfAtom(options.name)]);

  // {From, Text}: a bare term carries no sender, so nothing could answer it.
  const message = etfTuple([ourselves, etfBinary(Buffer.from(options.message, "utf8"))]);
  const packet = Buffer.concat([
    // Each term carries its own version magic, and the first is preceded by the
    // pass-through byte. This is what ei's send_reg builds.
    Buffer.from([PASS_THROUGH, ETF_VERSION]),
    control,
    Buffer.from([ETF_VERSION]),
    message,
  ]);
  if (trace) console.error(`sending ${packet.toString("hex")}`);
  socket.write(frame4(packet));

  const answer = await withTimeout(firstMessage(reader), TIMEOUT_MS, "no answer to the message");
  console.log(render(answer));
  socket.end();
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
