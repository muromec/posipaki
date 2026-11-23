// ── a TCP connection as a channel of bytes ──────────────────────────────────
//
// A real server on 127.0.0.1: what it writes is the frames, what it reads is what was sent, and how it ends is the
// channel's close.  Nothing here fakes a socket.

import { afterEach, describe, expect, it } from "vitest";

import { createServer, type Server, type Socket } from "node:net";

import type { Channel } from "../channel.js";
import { socketChannel } from "./socket.js";

const encode = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));
const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

const opened: Array<{ close(reason?: string): Promise<void> }> = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const channel of opened.splice(0)) await channel.close("the case is over").catch(() => undefined);
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A server on a port the OS picks, and that port. */
function serve(onSocket: (socket: Socket) => void): Promise<number> {
  const server = createServer(onSocket);
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

async function open(port: number): Promise<Channel<Uint8Array>> {
  const channel = await socketChannel({ host: "127.0.0.1", port });
  opened.push(channel);
  return channel;
}

/** The next frame, decoded. */
function nextFrame(channel: Channel<Uint8Array>): Promise<string> {
  return new Promise<string>((resolve) => channel.onFrame((bytes) => resolve(decode(bytes))));
}

describe("socketChannel", () => {
  it("carries what the peer wrote, and writes what is sent", async () => {
    const port = await serve((socket) => socket.on("data", (chunk: Buffer) => socket.write(chunk.toString().toUpperCase())));
    const channel = await open(port);
    const said = nextFrame(channel);
    await channel.send(encode("ping"));
    expect(await said).toBe("PING");
  });

  it("ends when the peer closes, and says what it said", async () => {
    const port = await serve((socket) => socket.end("bye"));
    const channel = await open(port);
    const said = nextFrame(channel);
    const reason = new Promise<string>((resolve) => channel.onClose(resolve));
    expect(await said).toBe("bye");
    expect(await reason).toBe("the far end closed");
  });

  it("refuses an address nothing answers, and names it", async () => {
    const port = await serve(() => undefined);
    const closed = new Promise<void>((resolve) => {
      const server = servers.pop();
      server?.close(() => resolve());
    });
    await closed;
    await expect(socketChannel({ host: "127.0.0.1", port })).rejects.toThrow(
      `socketChannel: 127.0.0.1:${port}:`,
    );
  });
});
