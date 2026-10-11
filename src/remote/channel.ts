// ── Frame channel ──────────────────────────────────────────────────────────
//
// The seam's shared vocabulary. A StringTransport moves encoded frames
// (strings); a Channel moves decoded frame objects. The frame guards narrow a
// decoded frame to one of the `$`-key shapes. server.ts / client.ts speak only
// in Channels and these guards — they never see a specific protocol or
// transport.

import type { FrameChannel, Message } from "../types.js";
import {
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

/**
 * A `FrameChannel` the remote layer can also unhook: `removeHandler` takes back the handler a
 * serve installed when it starts dispatching for itself.
 */
export interface Channel extends FrameChannel {
  removeHandler(): void;
}

// ── the address on a frame ─────────────────────────────────────────────────
//
// A frame that is about a process carries that process's id as `to`, at the top level
// of the frame rather than inside its body: the frame is the envelope, and the address
// says who it is for whatever kind it turns out to be.  Every frame that is about a
// process names it, the root of the connection included, since both ends number their
// own root and neither has to be guessed at.

/** The id a frame addresses, or null when it names no process. */
export function frameTo(frame: Record<string, unknown>): number | null {
  const to = frame.to;
  return typeof to === "number" ? to : null;
}

/**
 * A frame on its way out: every process in it becomes the reference this
 * connection uses for that process, and the process the frame addresses is
 * written down as `to`.
 */
export function encodeFrame(
  frame: Record<string, unknown>,
  table: ProcessTable,
  to: number,
): Record<string, unknown> {
  const encoded = encodeProcessRefs(frame, table) as Record<string, unknown>;
  return { ...encoded, to };
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

// ── a wire that could not be read ─────────────────────────────────────────
//
// Two frames are about the wire itself and not about a process: what a codec could
// not read, and what a side says when the wire is over.  Neither is addressed to
// anything, and both are decided before a frame is looked up as news or as an ask —
// a frame about the wire is about the ground the other frames stand on.
//
//   {"$bad": {"reason": "…", "raw": "…"}}   this side could not read that frame
//   {"$error": "…"}                          the wire cannot be spoken over, and why
//
// They are frames rather than raised errors on purpose.  A frame is read inside the
// transport's own callback — a socket's `message` event, a stream's line reader —
// where a throw belongs to nobody: it arrives at the host as an uncaught exception,
// and one unreadable frame from one peer takes the process down, every other
// connection in it included.  An unreadable frame is the connection's business, not
// the process's, so it is carried as a frame the connection can answer: `$bad` is how
// a reader says it inward, and `$error` is how a side says it outward before ending
// that connection.
//
// `$error` is not a refused call — a call that is refused says so about itself, in
// `$r.result.<name>` (see below).  This one is about the wire the calls travel on.

const BAD_KEY = "$bad";

/** How much of an unreadable line is carried: enough to see what it was, never enough to be it.
 *  A line that failed to parse is the one line nobody vouched for, so quoting it whole would move
 *  whatever it holds — a credential in a paste accident is how that happens — into every log,
 *  transcript and context window that later reads the frame.  Why, how long, and a short head of
 *  it.  (`reason` carries a little of the line on its own: a JSON parser says where it gave up and
 *  quotes what it was looking at.  That is the parser's business, not a promise this file makes.) */
export const BAD_PREFIX_LIMIT = 32;

export function isBad(msg: Record<string, unknown>): msg is { $bad: { reason: string } } {
  return BAD_KEY in msg;
}

/** The frame that says a frame could not be read: why, how long it was, and the head of it. */
export function badFrame(reason: string, raw: string): Record<string, unknown> {
  const prefix = raw.length > BAD_PREFIX_LIMIT ? `${raw.slice(0, BAD_PREFIX_LIMIT)}…` : raw;
  return { [BAD_KEY]: { reason, length: raw.length, prefix } };
}

/** Why a frame could not be read, or null when it is not a frame that says so. */
export function badReason(msg: Record<string, unknown>): string | null {
  const body = msg[BAD_KEY];
  if (typeof body !== "object" || body === null) return null;
  const reason = (body as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

const ERROR_KEY = "$error";

export function isError(msg: Record<string, unknown>): msg is { $error: string } {
  return ERROR_KEY in msg;
}

/** The frame that says the wire is over: the reason, and the connection ends with it. */
export function errorFrame(reason: string): Record<string, unknown> {
  return { [ERROR_KEY]: reason };
}

/** The reason a wire error carries, or null when it is not one. */
export function errorReason(msg: Record<string, unknown>): string | null {
  const reason = msg[ERROR_KEY];
  return typeof reason === "string" ? reason : null;
}

// ── the far end's own output ───────────────────────────────────────────────
//
// A process's own print is a frame of the connection like any other, read and written above the
// protocol step on both ends, so the transport carries it like every other frame.  The number is
// the stream a program knows, and what it wrote is a string.
//
//   {"$fd": 1, "data": "…"}

export type OutputFd = 1 | 2;

/** A frame of the far end's own output: `data` on the stream `fd`. */
export function outputFrame(fd: OutputFd, data: string): Record<string, unknown> {
  return { $fd: fd, data };
}

/** The output a frame carries, or null when it carries something else. */
export function outputOf(frame: Record<string, unknown>): { fd: OutputFd; data: string } | null {
  const fd = frame.$fd;
  if (fd !== 1 && fd !== 2) return null;
  const data = frame.data;
  return { fd, data: typeof data === "string" ? data : JSON.stringify(data) };
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
