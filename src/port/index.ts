// ── posipaki/port ───────────────────────────────────────────────────────────
//
// A port is a channel, a spawner that makes one, and adapters that wrap one into another.  This entry is
// everything below the seam: the channel type, a pair over nothing, a byte channel over a stream pair, the
// splitter, and the encoding that turns a line into a frame.  Still to come — the handshake and the owner.
//
// Remotes are built on this: the seam is `handshake(json1(split(port)))`.  Nothing here knows what the seam's
// frames say; a channel carries whatever its type parameter names.

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
