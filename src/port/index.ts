// ── posipaki/port ───────────────────────────────────────────────────────────
//
// A port is a channel, a spawner that makes one, and adapters that wrap one into another.  This entry is
// everything below the seam: the channel type, a pair over nothing, a byte channel over a stream pair, the
// splitter, the encoding that turns a line into a frame, and the handshake.  Still to come — the owner.
//
// Remotes are built on this: the seam is `handshake(json1(split(port, announced)))`, where `announced` is the
// seam's own rule for how many octets follow a line — the splitter is handed it rather than knowing it.  Nothing
// here knows what the seam's frames say; a channel carries whatever its type parameter names.

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
