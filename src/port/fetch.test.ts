// ── an HTTP request as a port ───────────────────────────────────────────────

import { afterEach, describe, expect, it } from "vitest";

import { fetchPort } from "./fetch.js";

const servers: Array<{ stop(force?: boolean): void; port: number }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A server that answers one path, and says what it was asked with an event stream. */
function serve(routes: Record<string, (request: Request) => Response | Promise<Response>>): number {
  const BunRt = (globalThis as { Bun?: { serve(options: unknown): { stop(force?: boolean): void; port: number } } })
    .Bun;
  if (BunRt === undefined) throw new Error("these tests need Bun's server");
  const server = BunRt.serve({
    port: 0,
    fetch: (request: Request) => {
      const handler = routes[new URL(request.url).pathname];
      return handler === undefined ? new Response("no route", { status: 404 }) : handler(request);
    },
  });
  servers.push(server);
  return server.port;
}

describe("fetchPort", () => {
  it("carries the body as frames, and says how the response ended", async () => {
    const port = await fetchPort(`http://127.0.0.1:${serve({ "/hi": () => new Response("hello") })}/hi`);
    const said: string[] = [];
    port.onFrame((bytes) => said.push(Buffer.from(bytes).toString("utf8")));
    const end = await new Promise((resolve) => port.onClose(resolve));

    expect(said.join("")).toBe("hello");
    expect(end).toEqual({ status: 200 });
  });

  it("reads a stream as it arrives, not as one body", async () => {
    const port = await fetchPort(
      `http://127.0.0.1:${serve({
        "/stream": () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode("one\n"));
                controller.enqueue(new TextEncoder().encode("two\n"));
                controller.close();
              },
            }),
          ),
      })}/stream`,
    );
    const said: string[] = [];
    port.onFrame((bytes) => said.push(Buffer.from(bytes).toString("utf8")));
    await new Promise((resolve) => port.onClose(resolve));

    expect(said.join("")).toBe("one\ntwo\n");
  });

  it("refuses an answer that is not a body worth reading, and says which", async () => {
    const url = `http://127.0.0.1:${serve({ "/gone": () => new Response("nope", { status: 404 }) })}/gone`;
    await expect(fetchPort(url)).rejects.toThrow(/answered 404: nope/);
  });

  it("refuses when nothing answers at all", async () => {
    await expect(fetchPort("http://127.0.0.1:1/x")).rejects.toThrow(/fetchPort: .*: /);
  });
});
