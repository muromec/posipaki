// ── the port mapper ────────────────────────────────────────────────────────
//
// A port mapper on the other end of a memory pair: it reads the framed request, answers the octets a real epmd
// answers, and closes — which is the only ending this exchange has.

import { afterEach, describe, expect, it } from "vitest";

import { memoryChannelPair } from "posipaki/port";
import { socketChannel } from "posipaki/port/node";

import { epmdPort, epmdRegister, serveEpmd, type Mapper } from "./epmd.js";
import { wrapEpmdFrame } from "./frame.js";

/** A mapper that answers `reply` and closes, and the request it was sent. */
function mapper(reply: Uint8Array | null) {
  const ends = memoryChannelPair<Uint8Array>();
  const framed = wrapEpmdFrame(ends.far);
  let asked: Uint8Array | null = null;
  framed.onFrame((frame) => {
    asked = frame;
    void (async () => {
      if (reply !== null) await ends.far.send(reply);
      await ends.far.close("the mapper is done");
    })();
  });
  return { channel: ends.near, asked: () => asked };
}

/** The answer a mapper gives: its tag, a result, and the port. */
function answered(port: number, result = 0): Uint8Array {
  return new Uint8Array([119, result, port >> 8, port & 0xff, 0x4d, 0, 0, 6, 0, 5, 0, 4, 0x72, 0x6f, 0x62]);
}

describe("epmdPort", () => {
  it("asks after a name and answers the port it was given", async () => {
    const { channel, asked } = mapper(answered(46257));
    expect(await epmdPort(channel, { host: "10.0.0.2", name: "robot" })).toBe(46257);
    expect(Buffer.from(asked() ?? []).toString("latin1")).toBe("\x7arobot");
  });

  it("refuses a name the mapper does not know", async () => {
    const { channel } = mapper(new Uint8Array([119, 1]));
    await expect(epmdPort(channel, { host: "10.0.0.2", name: "nobody" })).rejects.toThrow(
      "epmd on 10.0.0.2 does not know a node named nobody (result 1)",
    );
  });

  it("refuses an answer that is not the mapper's", async () => {
    const { channel } = mapper(new Uint8Array([120, 0, 0, 1]));
    await expect(epmdPort(channel, { host: "10.0.0.2", name: "robot" })).rejects.toThrow(
      "epmd answered request 120, not 119",
    );
  });

  it("refuses an answer that carried nothing", async () => {
    const { channel } = mapper(null);
    await expect(epmdPort(channel, { host: "10.0.0.2", name: "robot" })).rejects.toThrow(
      "epmd on 10.0.0.2 answered 0 bytes and nothing else",
    );
  });
});

describe("serveEpmd", () => {
  const mappers: Mapper[] = [];

  afterEach(async () => {
    for (const mapper of mappers.splice(0)) await mapper.close();
  });

  async function mapper(): Promise<Mapper> {
    const made = await serveEpmd(0);
    mappers.push(made);
    return made;
  }

  it("registers a node, answers where it listens, and forgets it when the node goes", async () => {
    const served = await mapper();
    const registration = await epmdRegister({ host: "127.0.0.1", mapperPort: served.port, name: "probe", port: 45_999 });

    const asked = await epmdPort(await socketChannel({ host: "127.0.0.1", port: served.port }), {
      host: "127.0.0.1",
      name: "probe",
    });
    expect(asked).toBe(45_999);
    expect(served.find("probe")).toBe(45_999);

    await registration.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(served.find("probe")).toBeNull();
    await expect(
      epmdPort(await socketChannel({ host: "127.0.0.1", port: served.port }), { host: "127.0.0.1", name: "probe" }),
    ).rejects.toThrow("does not know a node named probe");
  });
});
