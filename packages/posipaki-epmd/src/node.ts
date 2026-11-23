#!/usr/bin/env bun
/**
 * One node of this host: it registers with the mapper, accepts connections, and can say something to a node that is
 * not us. Both roles of the protocol in one process, which is what an answer to somebody else's pid needs.
 *
 *   bun src/mapper.ts
 *   bun src/node.ts --name probe@192.168.88.27 --cookie pocookie --say robot@192.168.88.20 --to relay
 *
 * Every message that arrives is printed. A message carrying a pid in a two-tuple — `{Pid, Text}` — is answered to
 * that pid, which may be on a node this side has no connection to yet: reaching it is `network.send`'s business.
 */

import { randomBytes } from "node:crypto";

import type { Channel } from "posipaki/port";

import { epmdRegister } from "./epmd.js";
import { listen } from "./listen.js";
import type { WireMessage } from "./messages.js";
import { network, type PidTerm } from "./network.js";
import { render, type Term } from "./terms.js";

function flag(argv: string[], name: string, fallback?: string): string {
  const at = argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : argv[at + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is needed`);
  }
  return value;
}

/** The local part of a node name, which is what the mapper registers. */
function localPart(name: string): string {
  const at = name.indexOf("@");
  if (at <= 0) throw new Error(`${name} is not a node name: it has no host`);
  return name.slice(0, at);
}

/** The pid in a `{Pid, Text}` payload, when that is what arrived. */
function pidIn(payload: Term | null): PidTerm | null {
  if (payload === null || payload.kind !== "tuple" || payload.items.length !== 2) return null;
  const first = payload.items[0];
  return first !== undefined && first.kind === "pid" ? first : null;
}

/** The text a `{Pid, Text}` payload carried, as words. */
function textIn(payload: Term | null): string {
  const text = payload?.kind === "tuple" ? payload.items[1] : undefined;
  return text?.kind === "binary" ? Buffer.from(text.bytes).toString("utf8") : "";
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

  const reach = network({ self, cookie, creation });
  const ourselves: Term = { kind: "pid", node: self, id: 1, serial: 0, creation };

  /** Answer the pid this message carried, on whichever node it names. */
  const answer = async (said: WireMessage): Promise<void> => {
    if (said.kind !== "message") return;
    const pid = pidIn(said.payload);
    if (pid === null) return;
    console.log(`  answering ${pid.node} directly`);
    const words = `${self} heard ${textIn(said.payload)}`;
    await reach.send(pid, { kind: "binary", bytes: Buffer.from(words, "utf8") });
  };

  /** Print what arrives on one connection, and answer a pid if the message carried one. */
  const report = (who: string, messages: Channel<WireMessage>): void => {
    messages.onFrame((said: WireMessage) => {
      if (said.kind !== "message") {
        console.log(`  ${who}: ${said.kind}`);
        return;
      }
      console.log(`  ${who} ${said.control.kind}: ${said.payload === null ? "nothing" : render(said.payload)}`);
      void answer(said).catch((error: unknown) =>
        console.log(`  could not answer: ${error instanceof Error ? error.message : String(error)}`),
      );
    });
    messages.onClose((reason) => console.log(`${who} left: ${reason}`));
  };

  const node = await listen({ self, cookie, creation, host, port }, {
    onConnection(peer, messages) {
      // A connection that arrived is the way to that node: a pid on it is answered over this, not over a new one.
      reach.adopt(peer, messages);
      console.log(`${peer.name} connected (incarnation ${peer.creation})`);
      report(peer.name, messages);
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
    const channel = await reach.channel(say);
    // What comes back on this side's own connection is the same kind of news as what arrives on an accepted one.
    report(say, channel);
    console.log(`saying ${JSON.stringify(message)} to ${to} on ${say}`);
    await channel.send({
      kind: "message",
      control: { kind: "regSend", from: ourselves, to },
      payload: {
        kind: "tuple",
        items: [ourselves, { kind: "binary", bytes: Buffer.from(message, "utf8") }],
      },
    });
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (async () => {
        await reach.close();
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
