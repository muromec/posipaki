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

// ── reflection frames ──────────────────────────────────────────────────────
//
// A reflection call crosses the seam as one frame and its answer as another:
//
//   {"$r.methods": ["inspect.getTree", …]}   the server's announcement, once
//   {"$r.call.<name>": {seq, args}}          client → server
//   {"$r.result.<name>": {seq, value}}       server → client, answered
//   {"$r.result.<name>": {seq, error}}       server → client, refused
//
// The method name is in the frame key, so a frame says what it is without a
// table, and `seq` — one connection's, never reused — tells two calls to the
// same method apart while both are in flight.

export const REFLECT_METHODS = "$r.methods";
export const REFLECT_CALL = "$r.call.";
export const REFLECT_RESULT = "$r.result.";

export interface ReflectionCall {
  name: string;
  seq: number;
  args: unknown[];
}

export interface ReflectionResult {
  name: string;
  seq: number;
  value?: unknown;
  error?: string;
}

export function isReflectionMethods(
  msg: Record<string, unknown>,
): msg is { "$r.methods": string[] } {
  const names = msg[REFLECT_METHODS];
  return Array.isArray(names) && names.every((name) => typeof name === "string");
}

function reflectionBody(
  frame: Record<string, unknown>,
  prefix: string,
): { name: string; body: Record<string, unknown> } | null {
  for (const key of Object.keys(frame)) {
    if (!key.startsWith(prefix) || key.length === prefix.length) continue;
    const body = frame[key];
    if (typeof body !== "object" || body === null) return null;
    return { name: key.slice(prefix.length), body: body as Record<string, unknown> };
  }
  return null;
}

/** A call frame, or null — a malformed one is not worth an answer. */
export function asReflectionCall(frame: Record<string, unknown>): ReflectionCall | null {
  const parsed = reflectionBody(frame, REFLECT_CALL);
  if (!parsed || typeof parsed.body.seq !== "number") return null;
  const args = parsed.body.args;
  return {
    name: parsed.name,
    seq: parsed.body.seq,
    args: Array.isArray(args) ? args : [],
  };
}

/** An answer frame, or null.  `error` present means the call was refused. */
export function asReflectionResult(frame: Record<string, unknown>): ReflectionResult | null {
  const parsed = reflectionBody(frame, REFLECT_RESULT);
  if (!parsed || typeof parsed.body.seq !== "number") return null;
  const { seq, value, error } = parsed.body;
  return typeof error === "string"
    ? { name: parsed.name, seq, error }
    : { name: parsed.name, seq, value };
}

/**
 * Why a value cannot cross a frame, or null when it can.  Only JSON data
 * crosses: a function, a symbol or a bigint cannot be written down at all, and
 * a value with a cycle or a bigint inside it makes the encoder throw.  What
 * JSON itself would quietly drop — a function stored inside an object — is the
 * caller's business, not something to invent a policy for here.
 */
export function jsonProblem(value: unknown): string | null {
  const kind = typeof value;
  if (kind === "function" || kind === "symbol" || kind === "bigint") return `a ${kind}`;
  if (kind !== "object" || value === null) return null;
  try {
    JSON.stringify(value);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}
