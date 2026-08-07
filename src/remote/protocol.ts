// ── Wire protocol types ────────────────────────────────────────────────────
//
// Message types on the wire (NDJSON, one JSON object per line).
//   child → host:  $proto, $state, $msg, $exit
//   host → child:  $init, $msg

export interface WireProto {
  $proto: string;
}

export interface WireInit {
  $init: Record<string, unknown>;
}

export interface WireState {
  $state: Record<string, unknown>;
}

export interface WireMsg {
  $msg: {
    type: string;
    fromName: string;
    fromIdName?: string;
    body: unknown;
  };
}

export interface WireExit {
  $exit: {
    code: number;
    state: unknown;
  };
}

export type WireMessage =
  | WireProto
  | WireInit
  | WireState
  | WireMsg
  | WireExit;

// ── encode / decode ────────────────────────────────────────────────────────

const PROTO_VERSION = "ndjson.v1";

export function encodeProto(): string {
  return JSON.stringify({ $proto: PROTO_VERSION }) + "\n";
}

export function encodeInit(args: Record<string, unknown>): string {
  return JSON.stringify({ $init: args }) + "\n";
}

export function encodeState(state: Record<string, unknown>): string {
  return JSON.stringify({ $state: state }) + "\n";
}

export function encodeMsg(
  type: string,
  fromName: string,
  fromIdName: string | undefined,
  body: unknown,
): string {
  return JSON.stringify({ $msg: { type, fromName, fromIdName, body } }) + "\n";
}

export function encodeExit(code: number, state: unknown): string {
  return JSON.stringify({ $exit: { code, state } }) + "\n";
}

export function decode(line: string): WireMessage {
  try {
    return JSON.parse(line) as WireMessage;
  } catch {
    throw new Error(`protocol: invalid JSON: ${line.slice(0, 100)}`);
  }
}

export function isProto(msg: WireMessage): msg is WireProto {
  return "$proto" in msg;
}

export function isInit(msg: WireMessage): msg is WireInit {
  return "$init" in msg;
}

export function isState(msg: WireMessage): msg is WireState {
  return "$state" in msg;
}

export function isMsg(msg: WireMessage): msg is WireMsg {
  return "$msg" in msg;
}

export function isExit(msg: WireMessage): msg is WireExit {
  return "$exit" in msg;
}
