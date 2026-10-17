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
  /**
   * A line arrived.  Answer with the number of raw octets that follow it, if any: a frame
   * may announce a run of bytes (a chunk of a stream), and the transport then hands those
   * octets over instead of reading them as more lines.
   */
  onMessage(handler: (frame: string) => number | void): void;
  /** The octets a line announced, whole, in the order they were sent. */
  onBytes(handler: (bytes: Uint8Array) => void): void;
  removeHandler(): void;
  /** Raw octets, written after whatever went before them. */
  sendBytes(bytes: Uint8Array): void | Promise<void>;
  /** Fires when the peer disconnects (transport closes from the other side). */
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

/**
 * What the frame layer needs of a connection's values: two walks, and no knowledge of how the
 * bytes travel.  The frame vocabulary lives in this file and the machinery in
 * `stream.ts`, so a store comes in as this shape rather than as an import from here.
 */
export interface ValueCodec {
  /** Replace every value that must cross by reference with one this connection serves. */
  encode(value: unknown): unknown;
  /** Replace every reference in a value with something the reader can hold. */
  decode(value: unknown): unknown;
}

/**
 * Several codecs over one connection, each value through all of them, in the order given.
 *
 * A connection carries more than one kind of thing by reference — a blob, a stream — and each
 * store knows only its own.  Walking a value through every store in turn is what keeps them
 * from having to know about each other.
 */
export function combineCodecs(...codecs: ValueCodec[]): ValueCodec {
  return {
    encode: (value) => codecs.reduce((current, codec) => codec.encode(current), value),
    decode: (value) => codecs.reduce((current, codec) => codec.decode(current), value),
  };
}

/** The frames of one connection, as the remote layer speaks them: the process's own `FrameChannel`,
 *  where a reader has the unsubscribe `onMessage` returned rather than a handler to take back. */
export type Channel = FrameChannel;

/** Is this something JSON would carry as an object, rather than an instance with behaviour? */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Is this a stream — a value whose bytes come later, carried by reference?
 *
 * The question every walk that copies containers has to ask: copying a stream keeps the object and
 * loses the behaviour, because its iterator is a symbol-keyed property and `Object.entries` does not
 * see those.  What such a value is belongs to `stream.ts`; that it must be left alone belongs to
 * every layer that walks a message.
 */
export function isStreamLike(value: unknown): value is AsyncIterable<Uint8Array> {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Partial<AsyncIterable<Uint8Array>>)[Symbol.asyncIterator] === "function";
}

/**
 * One handler on the wire, however many readers on it.  A transport holds one handler — and reports a
 * second one as a mistake — so the layer above keeps the readers and installs a single handler; the
 * subscribe this returns is what a reader calls to leave.  The handler goes on with the first reader and
 * stays for the life of the connection: taking it off between readers would drop whatever arrives in
 * between, and a connection is not paused by nobody reading it.
 */
export function frameReaders(
  install: (deliver: (frame: Record<string, unknown>) => void) => void,
): (handler: (frame: Record<string, unknown>) => void) => () => void {
  const readers = new Set<(frame: Record<string, unknown>) => void>();
  let installed = false;
  return (handler) => {
    if (!installed) {
      installed = true;
      install((frame) => {
        // Over a copy: a reader that leaves as it is handed a frame must not cut the rest short.
        for (const reader of [...readers]) reader(frame);
      });
    }
    readers.add(handler);
    return () => {
      readers.delete(handler);
    };
  };
}

/**
 * A channel that is `base`, with every incoming frame offered to `onFrame` first — and not handed
 * on when it is claimed.
 *
 * Every wrapper above a protocol wants this one thing, and none of them may lose the octets: a
 * connection that carries segments keeps carrying them through whatever wraps it, or a stream
 * dies one layer above the wire it was written for.
 */
export function channelThrough(base: Channel, onFrame: (frame: Record<string, unknown>) => boolean): Channel {
  const wrapped: Channel = {
    send: (frame) => base.send(frame),
    onMessage: (handler) =>
      base.onMessage((frame) => {
        if (onFrame(frame)) return;
        handler(frame);
      }),
    onClose: (handler) => base.onClose(handler),
    close: () => base.close(),
  };
  if (base.sendSegment) {
    wrapped.sendSegment = (frame, bytes) => base.sendSegment?.(frame, bytes);
  }
  if (base.onSegment) {
    wrapped.onSegment = (handler) => base.onSegment?.(handler) ?? (() => {});
  }
  return wrapped;
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
  codecs?: ValueCodec,
): Record<string, unknown> {
  const withProcesses = encodeProcessRefs(frame, table) as Record<string, unknown>;
  const encoded = codecs === undefined ? withProcesses : (codecs.encode(withProcesses) as Record<string, unknown>);
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
  codecs?: ValueCodec,
): Record<string, unknown> {
  const resolved = decodeProcessRefs(frame, resolve) as Record<string, unknown>;
  return codecs === undefined ? resolved : (codecs.decode(resolved) as Record<string, unknown>);
}

// ── frame guards ──────────────────────────────────────────────────────────
//
// Each guard narrows a decoded frame to the frame it is, and each of those types is
// named, so the whole set can be written down once (see `Frame`, at the foot of this
// file).  A guard asks only whether the key is there: the body under it belongs to
// whoever wrote it.

export type ProtoFrame = {
  $proto: string;
};
export type InitFrame = {
  $init: Record<string, unknown>;
};
export type StateFrame = {
  $state: Record<string, unknown>;
};
export type MsgFrame = {
  $msg: { fromName: string; body: Message };
};
export type ExitFrame = {
  $exit: { code: number; state: unknown };
};

export function isProto(msg: Record<string, unknown>): msg is ProtoFrame {
  return "$proto" in msg;
}
export function isInit(msg: Record<string, unknown>): msg is InitFrame {
  return "$init" in msg;
}
export function isState(msg: Record<string, unknown>): msg is StateFrame {
  return "$state" in msg;
}
export function isMsg(msg: Record<string, unknown>): msg is MsgFrame {
  return "$msg" in msg;
}
export function isExit(msg: Record<string, unknown>): msg is ExitFrame {
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

export type BadFrame = {
  $bad: { reason: string };
};

export function isBad(msg: Record<string, unknown>): msg is BadFrame {
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

export type ErrorFrame = {
  $error: string;
};

export function isError(msg: Record<string, unknown>): msg is ErrorFrame {
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

export type StopFrame = {
  $stop: Record<string, unknown>;
};
export type PauseFrame = {
  $pause: Record<string, unknown>;
};
export type ResumeFrame = {
  $resume: Record<string, unknown>;
};
export type ReleaseFrame = {
  $release: Record<string, unknown>;
};
export type TuneFrame = {
  $tune: Record<string, unknown>;
};

export function isStop(msg: Record<string, unknown>): msg is StopFrame {
  return "$stop" in msg;
}
export function isPause(msg: Record<string, unknown>): msg is PauseFrame {
  return "$pause" in msg;
}
export function isResume(msg: Record<string, unknown>): msg is ResumeFrame {
  return "$resume" in msg;
}
export function isRelease(msg: Record<string, unknown>): msg is ReleaseFrame {
  return "$release" in msg;
}
export function isTune(msg: Record<string, unknown>): msg is TuneFrame {
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

export type ReflectionMethodsFrame = {
  "$r.methods": string[];
};

/** A call frame: the method in the key, the call in the body (`$r.call.<name>`). */
export type ReflectionCallFrame = {
  [key: `$r.call.${string}`]: { seq: number; args?: unknown[] };
};

/** An answer frame: `value` or `error`, naming the seq it settles. */
export type ReflectionResultFrame = {
  [key: `$r.result.${string}`]: { seq: number; value?: unknown; error?: string };
};

export function isReflectionMethods(msg: Record<string, unknown>): msg is ReflectionMethodsFrame {
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

// ── the frames, as one type ────────────────────────────────────────────────
//
// The guards above say what a frame is one at a time; this is the same set as one type.
// Neither direction nor protocol is in it — who may send which is the two ends' business,
// and the handshake names the protocol that writes them.  The address a frame carries
// (`to`, `frameTo`) is the envelope the connection writes around it, not the frame.

export type Frame =
  | ProtoFrame
  | InitFrame
  | StateFrame
  | MsgFrame
  | ExitFrame
  | BadFrame
  | ErrorFrame
  | StopFrame
  | PauseFrame
  | ResumeFrame
  | ReleaseFrame
  | TuneFrame
  | ReflectionMethodsFrame
  | ReflectionCallFrame
  | ReflectionResultFrame;
