// ── posipaki/port ───────────────────────────────────────────────────────────
//
// The layer the remote is built on: a channel of values of one type, a pair of them in memory, a channel of bytes
// over a stream pair, the splitter that cuts bytes into lines, the encoding of a line as a frame, and the handshake
// that agrees a protocol.
//
// A remote connection composes as `handshake(json1(split(port, announced)))`.  `announced` is the caller's rule
// for how many octets follow a line, so the splitter does not carry it; nothing here knows what a frame says.
//
// Not in this entry: the owner, one actor over a channel.  It is the next piece of work and is described in
// docs/proposals/ports.md.

export { ChannelClosed, type Channel, type Part } from "./channel.js";
export { memoryChannelPair, type ChannelPair, type MemoryEnd } from "./memory.js";
export { splitChannel, type Announcement } from "./split.js";
export { streamChannel, type StreamPair } from "./stream.js";
export {
  badFrame,
  badReason,
  BAD_PREFIX_LIMIT,
  decode,
  encode,
  isBad,
  json1,
  readFrame,
  type BadFrame,
  type Delivered,
} from "./json1.js";
export {
  handshake,
  HandshakeError,
  HANDSHAKE_TIMEOUT_MS,
  PROTO_KEY,
  protoFrame,
  protoVersion,
  type HandshakeOptions,
} from "./handshake.js";
