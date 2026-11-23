// ── the port mapper ─────────────────────────────────────────────────────────
//
// epmd says where a node listens. The request is framed like every message before the handshake — a two-byte
// length — and the answer is not framed at all: it is the octets epmd sends before it closes the socket. That is
// why this sits beside the frame layer rather than on top of it: one packet on this wire announces no length.

import type { Channel } from "posipaki/port";

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
