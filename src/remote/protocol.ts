// ── Wire protocol ──────────────────────────────────────────────────────────
//
// NDJSON wire protocol: one JSON object per line.
//   child → host:  $proto, $state, $msg, $exit
//   host → child:  $init, $msg

export const PROTO_VERSION = "ndjson.v1";

export function encode(key: string, value: unknown): string {
  return JSON.stringify({ [key]: value }) + "\n";
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
export function isMsg(msg: Record<string, unknown>): msg is { $msg: { type: string; fromName: string; body: unknown } } {
  return "$msg" in msg;
}
export function isExit(msg: Record<string, unknown>): msg is { $exit: { code: number; state: unknown } } {
  return "$exit" in msg;
}
