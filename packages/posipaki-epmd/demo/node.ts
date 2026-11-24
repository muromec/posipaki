#!/usr/bin/env bun
/**
 * One node of this host: it registers with the mapper, accepts connections, and can say something to a node that is
 * not us. Both roles of the protocol in one program.
 *
 *   bun demo/mapper.ts
 *   bun demo/node.ts --name probe@192.168.88.27 --cookie pocookie --say robot@192.168.88.20 --to relay
 *
 * Every connection is an `ErlangNode`, serving one process under this node's own name: what the peer addresses arrives
 * at that process as a term, and what the process answers leaves as an address. This file only wires the two.
 */

import { randomBytes } from "node:crypto";

import { installCluster, makeCluster, refFromName } from "../src/cluster.js";
import { epmdRegister } from "../src/epmd.js";
import { listen } from "../src/listen.js";
import { ErlangNode } from "../src/served.js";
import { binary, tuple } from "../src/terms.js";
import { Answerer } from "./answerer.js";

function flag(argv: string[], name: string, fallback?: string): string {
  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is needed`);
  }
  return value;
}

/** The local part of a node name: what the mapper registers, and what a peer addresses. */
function localPart(name: string): string {
  const at = name.indexOf("@");
  if (at <= 0) throw new Error(`${name} is not a node name: it has no host`);
  return name.slice(0, at);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const self = flag(argv, "name");
  const cookie = flag(argv, "cookie");
  const host = flag(argv, "host", "0.0.0.0");
  const port = Number(flag(argv, "port", "0"));
  const mapperAt = flag(argv, "mapper", "127.0.0.1:4369");
  const say = argv.includes("--say") ? flag(argv, "say") : null;
  const to = flag(argv, "to", "relay");
  const message = flag(argv, "message", "hi");
  const creation = randomBytes(4).readUInt32BE(0) || 1;

  const cluster = installCluster(makeCluster({ name: "demo", self, cookie, creation }));

  // One process, served on every connection and the sender of what this node says: an answer comes back to the pid,
  // and this is the process that pid was minted for.
  const answerer = await Answerer.spawn(undefined);
  const ourPid = cluster.pidOf(answerer);

  const node = await listen({ self, cookie, creation, host, port }, {
    onConnection(peer, messages) {
      // A connection that arrived is the way to that node: a pid on it is answered over this, not over a new one.
      cluster.adopt(peer, messages);
      console.log(`${peer.name} connected (incarnation ${peer.creation})`);
      void ErlangNode.spawn({
        node: refFromName(peer.name, cluster.name),
        peer,
        messages,
        serves: [{ name: localPart(self), process: answerer }],
      });
    },
    onRefused(error) {
      console.log(`refused a connection: ${error.message}`);
    },
  });

  const [mapperHost, mapperPort] = mapperAt.split(":");
  const registration = await epmdRegister({
    host: mapperHost ?? "127.0.0.1",
    mapperPort: Number(mapperPort ?? 4369),
    name: localPart(self),
    port: node.port,
  });
  console.log(`${self} listening on ${host}:${node.port}, registered with ${mapperAt}`);

  if (say !== null) {
    const where = refFromName(say, cluster.name);
    const channel = await cluster.channel(where);
    // What comes back on a connection this side opened arrives the same way as what arrives on an accepted one: the
    // same process is served on both.
    void ErlangNode.spawn({ node: where, messages: channel, serves: [{ name: localPart(self), process: answerer }] });
    console.log(`saying ${JSON.stringify(message)} to ${to} on ${say}`);
    await channel.send({
      kind: "message",
      control: { kind: "regSend", from: ourPid, to },
      payload: tuple(ourPid, binary(Buffer.from(message, "utf8"))),
    });
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (async () => {
        await cluster.close();
        await node.close();
        await registration.close();
        process.exit(0);
      })();
    });
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
