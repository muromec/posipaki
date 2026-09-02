// ── json1 wire protocol ────────────────────────────────────────────────────
//
// One JSON object per frame: `{"$key": value}`. encode/decode turn a decoded
// frame object into a string and back. json1Channel wraps a StringTransport so
// it moves frame objects instead of strings.

import type { Channel, StringTransport } from "../channel.js";

export const VERSION = "json.v1";

export function encode(frame: Record<string, unknown>): string {
  return JSON.stringify(frame);
}

export function decode(str: string): Record<string, unknown> {
  return JSON.parse(str);
}

export function json1Channel(transport: StringTransport): Channel {
  return {
    send(frame) {
      return transport.send(encode(frame));
    },
    onMessage(handler) {
      transport.onMessage((str) => handler(decode(str)));
    },
    removeHandler() {
      transport.removeHandler();
    },
    onClose(handler) {
      transport.onClose(handler);
    },
    close() {
      return transport.close();
    },
  };
}
