// ── Frame channel ──────────────────────────────────────────────────────────
//
// The seam's shared vocabulary. A StringTransport moves encoded frames
// (strings); a Channel moves decoded frame objects. The frame guards narrow a
// decoded frame to one of the `$`-key shapes. server.ts / client.ts speak only
// in Channels and these guards — they never see a specific protocol or
// transport.

import type { Message } from "../types.js";

export interface StringTransport {
  send(frame: string): void | Promise<void>;
  onMessage(handler: (frame: string) => void): void;
  removeHandler(): void;
  /** Fires when the peer disconnects (transport closes from the other side). */
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

export interface Channel {
  send(frame: Record<string, unknown>): void | Promise<void>;
  onMessage(handler: (frame: Record<string, unknown>) => void): void;
  removeHandler(): void;
  /** Fires when the peer disconnects (transport closes from the other side). */
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

// ── frame guards ──────────────────────────────────────────────────────────

export function isProto(msg: Record<string, unknown>): msg is { $proto: string } {
  return "$proto" in msg;
}
export function isInit(msg: Record<string, unknown>): msg is { $init: Record<string, unknown> } {
  return "$init" in msg;
}
export function isState(msg: Record<string, unknown>): msg is { $state: Record<string, unknown> } {
  return "$state" in msg;
}
export function isMsg(
  msg: Record<string, unknown>,
): msg is { $msg: { fromName: string; body: Message } } {
  return "$msg" in msg;
}
export function isExit(
  msg: Record<string, unknown>,
): msg is { $exit: { code: number; state: unknown } } {
  return "$exit" in msg;
}
