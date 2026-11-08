// ── the two ports that wrap a process ───────────────────────────────────────
//
// Both are `portActor` over `spawnPorts`: one carries the child's octets as they are, the other puts the splitter
// underneath and carries lines.  The names are the contract — an actor definition is spawned by name.

import type { Message } from "../../types.js";
import { portActor } from "../actor.js";
import type { Channel, Part } from "../channel.js";
import { splitChannel } from "../split.js";
import { spawnPorts, type ProcessEnd } from "./spawn.js";

/** How a process port is started. */
export interface ProcessPortArgs {
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** How long the process may live after its stdin is closed.  Default 5000 ms, then SIGKILL. */
  killAfterMs?: number;
}



/** Parts as their text: what a line port carries.  Octets that came with a line are not text and are dropped. */
function lines(parts: Channel<Part, ProcessEnd>): Channel<string, ProcessEnd> {
  const readers = new Set<(line: string) => void>();
  const closers = new Set<(reason: ProcessEnd) => void>();
  const failers = new Set<(error: unknown) => void>();

  parts.onFrame(({ line }) => {
    for (const reader of [...readers]) reader(line);
  });
  parts.onClose((reason) => {
    for (const closer of [...closers]) closer(reason);
  });
  parts.onError((error) => {
    for (const failer of [...failers]) failer(error);
  });

  return {
    send: (line) => parts.send({ line, bytes: null }),
    onFrame(handler) {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    onClose(handler) {
      closers.add(handler);
      return () => {
        closers.delete(handler);
      };
    },
    onError(handler) {
      failers.add(handler);
      return () => {
        failers.delete(handler);
      };
    },
    close: (reason) => parts.close(reason),
  };
}

/** What a process port knows about itself: the id the kernel gave the process it started. */
export interface ProcessInfo {
  pid: number | undefined;
}

/** The child's octets, frame for frame. */
export const BinaryPort = portActor<ProcessPortArgs, Uint8Array, ProcessEnd, ProcessInfo>({
  name: "binary-port",
  open: async (args) => {
    const ports = await spawnPorts(args.command, args);
    return { channel: ports.stdout, info: { pid: ports.pid }, signal: (name) => ports.signal(name) };
  },
});

/** The same child, cut into lines. */
export const Utf8Port = portActor<ProcessPortArgs, string, ProcessEnd, ProcessInfo>({
  name: "utf8-port",
  open: async (args) => {
    const ports = await spawnPorts(args.command, args);
    return {
      channel: lines(splitChannel(ports.stdout)),
      info: { pid: ports.pid },
      signal: (name) => ports.signal(name),
    };
  },
});
