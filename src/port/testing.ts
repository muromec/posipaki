// ── the doubles these adapters are tested against ─────────────────────────
//
// A port is a channel, so a double is a channel too: one that records what was written, and one the test
// writes into.  Nothing here knows what a protocol is.

import type { Channel } from "./channel.js";

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
export const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** What was written to an outbound port: the head it was told, the frames, and whether it ended. */
export interface Written {
  head: Record<string, unknown> | null;
  frames: string[];
  ended: boolean;
}

/** An outbound port that records instead of writing, so a head is asserted as the command it is. */
export function recording(): { out: Channel<Uint8Array, void>; written: Written } {
  const written: Written = { head: null, frames: [], ended: false };
  const out: Channel<Uint8Array, void> = {
    send: async (frame) => {
      written.frames.push(decode(frame));
    },
    onFrame: () => () => {},
    onClose: () => () => {},
    onError: () => () => {},
    close: async () => {
      written.ended = true;
    },
    info: {},
    hasFrames: async () => false,
    control: (command) => {
      written.head = command['head'] as Record<string, unknown>;
    },
  };
  return { out, written };
}

/** An inbound port the test writes into, and then ends. */
export function incoming(): {
  inbound: Channel<Uint8Array, void>;
  write: (text: string) => void;
  bytes: (chunk: Uint8Array) => void;
  end: () => void;
} {
  const readers = new Set<(chunk: Uint8Array) => void>();
  const closers = new Set<() => void>();
  let ended = false;
  const inbound: Channel<Uint8Array, void> = {
    send: () => Promise.reject(new Error('a request body has no input')),
    onFrame: (handler) => {
      readers.add(handler);
      return () => {
        readers.delete(handler);
      };
    },
    onClose: (handler) => {
      if (ended) {
        handler();
        return () => {};
      }
      closers.add(handler);
      return () => {
        closers.delete(handler);
      };
    },
    onError: () => () => {},
    close: async () => {
      ended = true;
    },
    info: {},
    hasFrames: async () => false,
    control: () => {},
  };
  return {
    inbound,
    bytes: (chunk) => {
      for (const reader of readers) reader(chunk);
    },
    write: (text) => {
      for (const reader of readers) reader(encode(text));
    },
    end: () => {
      ended = true;
      for (const closer of closers) closer();
    },
  };
}
