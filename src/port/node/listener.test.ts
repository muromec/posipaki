// ── an HTTP server whose answers are ports ──────────────────────────────────
//
// A real Bun server and a real fetch.  The client's head arrives with the first frame the handler writes, which
// is how HTTP works: a request is started, the handler answers, and the client reads from there.

import { afterEach, describe, expect, it } from "vitest";

import { fetchPort, type HttpEnd } from "../fetch.js";
import type { Channel } from "../channel.js";
import { httpListener, type HttpAccept, type HttpListener } from "./listener.js";

const open: Array<HttpListener<unknown>> = [];

afterEach(async () => {
  for (const listener of open.splice(0)) await listener.close();
});

function listen<Meta>(identify?: (request: Request) => Meta): HttpListener<Meta> {
  const listener = httpListener<Meta>({ port: 0, identify });
  open.push(listener as HttpListener<unknown>);
  return listener;
}

/** Everything a client port said, and how it ended. */
async function read(port: Channel<Uint8Array, HttpEnd>): Promise<{ said: string; end: HttpEnd }> {
  const parts: string[] = [];
  port.onFrame((bytes) => parts.push(Buffer.from(bytes).toString("utf8")));
  const end = await new Promise<HttpEnd>((resolve) => port.onClose(resolve));
  return { said: parts.join(""), end };
}

describe("httpListener", () => {
  it("hands the request to accept(), and the body is what the channel wrote", async () => {
    const listener = listen();
    const client = fetchPort(`http://127.0.0.1:${listener.port}/one`);
    const request: HttpAccept<unknown> = await listener.accept();

    await request.response.send(new TextEncoder().encode("hello"));
    await request.response.close();

    expect(await read(await client)).toEqual({ said: "hello", end: { status: 200 } });
  });

  it("answers with a stream when the channel keeps writing", async () => {
    const listener = listen();
    const client = fetchPort(`http://127.0.0.1:${listener.port}/stream`);
    const request = await listener.accept();

    await request.response.send(new TextEncoder().encode("one\n"));
    await request.response.send(new TextEncoder().encode("two\n"));
    await request.response.close();

    expect((await read(await client)).said).toBe("one\ntwo\n");
  });

  it("refuses before a body exists when identify throws", async () => {
    const listener = listen<never>(() => {
      throw new Error("no token");
    });
    await expect(fetchPort(`http://127.0.0.1:${listener.port}/x`)).rejects.toThrow(/answered 401: no token/);
  });

  it("gives identify's answer to the handler as meta", async () => {
    const listener = listen((request: Request) => new URL(request.url).pathname);
    const client = fetchPort(`http://127.0.0.1:${listener.port}/who`);
    const request = await listener.accept();

    expect(request.meta).toBe("/who");
    await request.response.send(new TextEncoder().encode("ok"));
    await request.response.close();
    await read(await client);
  });
});
