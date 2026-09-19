// ── Frame channel ──────────────────────────────────────────────────────────
//
// The seam's shared vocabulary. A StringTransport moves encoded frames
// (strings); a Channel moves decoded frame objects. The frame guards narrow a
// decoded frame to one of the `$`-key shapes. server.ts / client.ts speak only
// in Channels and these guards — they never see a specific protocol or
// transport.

import type { Message } from "../types.js";
import {
  ROOT_ID,
  decodeProcessRefs,
  encodeProcessRefs,
  type ProcessTable,
  type RefResolver,
} from "./process-ref.js";

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

// ── the address on a frame ─────────────────────────────────────────────────
//
// A frame that is about a process carries that process's id as `to`, at the top
// level of the frame rather than inside its body: the frame is the envelope, and
// the address says who it is for whatever kind it turns out to be.  A frame that
// carries no address is for the root of the connection.

/**
 * The id a frame addresses, or null when what it carries is not an id.  Naming
 * no process and naming the root are the same thing, so both answer ROOT_ID.
 */
export function frameTo(frame: Record<string, unknown>): number | null {
  const to = frame.to;
  if (to === undefined) return ROOT_ID;
  return typeof to === "number" ? to : null;
}

/**
 * A frame on its way out: every process in it becomes the reference this
 * connection uses for that process, and the process the frame addresses is
 * written down as `to` — unless it is the root, which is named by carrying no
 * address at all.
 */
export function encodeFrame(
  frame: Record<string, unknown>,
  table: ProcessTable,
  to: number = ROOT_ID,
): Record<string, unknown> {
  const encoded = encodeProcessRefs(frame, table) as Record<string, unknown>;
  return to === ROOT_ID ? encoded : { ...encoded, to };
}

/**
 * A frame just read: every reference in it becomes a handle on that process — or
 * the handle this side already made for it, since the same process handed over
 * twice is one process.
 */
export function decodeFrame(
  frame: Record<string, unknown>,
  resolve: RefResolver,
): Record<string, unknown> {
  return decodeProcessRefs(frame, resolve) as Record<string, unknown>;
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

// ── what is said about a crossed process ────────────────────────────────────
//
// A process that crossed can be asked for less than everything, or for nothing at
// all: what crosses about it is three categories, and only the ones asked for are
// sent.  Silence is the empty list, so a handle that asks for nothing hears
// nothing — not its state, not its messages, and not that it is gone.
//
//   {"$tune": {"streams": ["state"]}, "to": 3}   this much about it, and no more

export type StreamKind = "message" | "state" | "exit";

/** The three, in the one order they are ever named in — the order a tune frame
 *  carries them in, so two ways of asking for the same thing look the same. */
export const STREAM_KINDS: StreamKind[] = ["message", "state", "exit"];

export function isStreamKind(value: unknown): value is StreamKind {
  return typeof value === "string" && (STREAM_KINDS as string[]).includes(value);
}

// ── control frames ─────────────────────────────────────────────────────────
//
// What the holder of a handle can ask of a process on the far side, beside
// sending it a message.  Each is a frame of its own rather than a message, so
// nothing an actor reads is ever a control signal by accident:
//
//   {"$stop": {}, "to": 3}      stop it; it ends, and its `$exit` crosses back
//   {"$pause": {}, "to": 3}     stop feeding it messages
//   {"$resume": {}, "to": 3}    feed it again
//   {"$release": {}, "to": 3}   let it go: forget this id, and stop telling me
//                               about the process behind it
//   {"$tune": {"streams": [...]}, "to": 3}
//                               say this much about it and no more: a subset of
//                               message, state and exit, or the empty list for
//                               silence
//
// They address the process they are about, so they are answered by whoever holds
// that process — the side that can act on it.  Stopping the *root* of a connection
// is not one of these: that stays the STOP message it always was, since the root
// is not a handle but the process this side is talking through.

export function isStop(msg: Record<string, unknown>): msg is { $stop: Record<string, unknown> } {
  return "$stop" in msg;
}
export function isPause(msg: Record<string, unknown>): msg is { $pause: Record<string, unknown> } {
  return "$pause" in msg;
}
export function isResume(msg: Record<string, unknown>): msg is { $resume: Record<string, unknown> } {
  return "$resume" in msg;
}
export function isRelease(msg: Record<string, unknown>): msg is { $release: Record<string, unknown> } {
  return "$release" in msg;
}

export function isTune(msg: Record<string, unknown>): msg is { $tune: Record<string, unknown> } {
  return "$tune" in msg;
}

/**
 * The categories a tune frame asks for, in the order they are named in — or null
 * when the frame says something this vocabulary has no word for, which is a frame
 * to ignore rather than to guess at.
 */
export function tuneFrame(frame: { $tune: unknown }): StreamKind[] | null {
  const body = frame.$tune;
  if (typeof body !== "object" || body === null) return null;
  const streams = (body as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return null;
  if (!streams.every(isStreamKind)) return null;
  return STREAM_KINDS.filter((kind) => (streams as StreamKind[]).includes(kind));
}

// ── reflection frames ──────────────────────────────────────────────────────
//
// A reflection call crosses the seam as one frame and its answer as another, and
// both go both ways: whoever holds a process is the one that answers for it.
//
//   {"$r.methods": ["inspect.getTree", …]}   what a process can answer, once, when
//                                            it crosses (and, for the root, once
//                                            when the connection opens)
//   {"$r.call.<name>": {seq, args}}          asking, addressed to the process
//   {"$r.result.<name>": {seq, value}}       answered
//   {"$r.result.<name>": {seq, error}}       refused
//
// The method name is in the frame key, so a frame says what it is without a
// table, and `seq` — one connection's, never reused — tells two calls to the
// same method apart while both are in flight.  An answer is about the call and not
// about a process, so it carries no address: it names the seq it settles.

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
