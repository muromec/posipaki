// ── Wire protocol ──────────────────────────────────────────────────────────
//
// Frame vocabulary: one JSON object per frame. Framing (newlines, message
// boundaries) and serialization are the transport's concern, not here.
//   server → client:  $proto, $state, $msg, $exit
//   client → server:  $init, $msg
import type { Message } from "../types.js";

export const PROTO_VERSION = "json.v1";

export function encode(key: string, value: unknown): string {
  return JSON.stringify({ [key]: value });
}

export function decode(line: string): Record<string, unknown> {
  return JSON.parse(line);
}

// ── type guards ──────────────────────────────────────────────────────────

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
