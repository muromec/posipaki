// ── posipaki/port ───────────────────────────────────────────────────────────
//
// A port is a channel, a spawner that makes one, and adapters that wrap one into another.  This entry is the
// whole of it that has no medium in it: the types, the in-memory pair, and — as the slices land — the line
// splitter, the seam's encoding and the owner actor.
//
// Remotes are built on this: the seam is `handshake(json1(split(port)))`.  Nothing here knows what the seam's
// frames say; a channel carries whatever its type parameter names.

export { ChannelClosed, type Channel, type Part } from "./channel.js";
export { memoryChannelPair, type ChannelPair, type MemoryEnd } from "./memory.js";
