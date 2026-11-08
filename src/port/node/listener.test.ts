// ── an HTTP server as a port listener ───────────────────────────────────────
//
// A real Bun server and a real fetch.  The request arrives as a pair: its body is the inbound port, the answer is
// written into the outbound one, and the client reads what that port wrote.

import { afterEach, describe, expect, it } from "vitest";

import type { Channel } from "../channel.js";
import { fetchPort, type HttpEnd } from "../fetch.js";
import { portReactor } from "../reactor.js";
import { httpListener, type HttpListener } from "./listener.js";

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
  it("answers with what the outbound port wrote, as a whole body", async () => {
    const listener = listen();
    const client = fetchPort(`http://127.0.0.1:${listener.port}/one`);
    const pair = await listener.accept();

    await pair.outbound.send(new TextEncoder().encode("hello"));
    await pair.outbound.close();

    expect(await read(await client)).toEqual({ said: "hello", end: { status: 200 } });
  });

  it("answers with a stream when the outbound port keeps writing", async () => {
    const listener = listen();
    const client = fetchPort(`http://127.0.0.1:${listener.port}/stream`);
    const pair = await listener.accept();

    await pair.outbound.send(new TextEncoder().encode("one\n"));
    await pair.outbound.send(new TextEncoder().encode("two\n"));
    await pair.outbound.close();

    expect((await read(await client)).said).toBe("one\ntwo\n");
  });

  it("carries the request's body as the inbound port", async () => {
    const listener = listen();
    const client = fetchPort(`http://127.0.0.1:${listener.port}/post`, {
      init: { method: "POST", body: "ping" },
    });
    const pair = await listener.accept();

    const received: string[] = [];
    pair.inbound.onFrame((bytes) => received.push(Buffer.from(bytes).toString("utf8")));
    await new Promise((resolve) => pair.inbound.onClose(resolve));

    await pair.outbound.send(new TextEncoder().encode("pong"));
    await pair.outbound.close();
    await read(await client);

    expect(received.join("")).toBe("ping");
  });

  it("refuses before a pair exists when identify throws", async () => {
    const listener = listen<never>(() => {
      throw new Error("no token");
    });
    await expect(fetchPort(`http://127.0.0.1:${listener.port}/x`)).rejects.toThrow(/answered 401: no token/);
  });

  it("gives identify's answer to the handler as meta", async () => {
    const listener = listen((request: Request) => new URL(request.url).pathname);
    const client = fetchPort(`http://127.0.0.1:${listener.port}/who`);
    const pair = await listener.accept();

    expect(pair.meta).toBe("/who");
    await pair.outbound.send(new TextEncoder().encode("ok"));
    await pair.outbound.close();
    await read(await client);
  });

  it("serves the pairs through portReactor, one handler per request", async () => {
    const listener = listen();
    const seen: string[] = [];
    const reactor = portReactor(listener, async (pair) => {
      seen.push(pair.meta as string);
      await pair.outbound.send(new TextEncoder().encode("done"));
      await pair.outbound.close();
    });

    const client = fetchPort(`http://127.0.0.1:${listener.port}/via-reactor`);
    expect((await read(await client)).said).toBe("done");
    await reactor.stop();

    expect(seen).toHaveLength(1);
  });
});
