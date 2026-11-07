// ── posipaki/port ───────────────────────────────────────────────────────────
//
// Channels and the media that carry them: values of one type between two ends, a pair of them in memory, a
// channel of bytes over a stream pair, and the splitter that cuts those bytes into lines.
//
// Nothing here knows a protocol.  A protocol is an adapter over one of these channels and lives above, with the
// thing that speaks it: `src/remote/protocols` is json.v1, and `src/remote/seam.ts` composes it.
//
// Not in this entry: the owner, one actor over a channel.  It is the next piece of work and is described in
// docs/proposals/ports.md.

export { ChannelClosed, type Channel, type Part } from "./channel.js";
export { memoryChannelPair, type ChannelPair, type MemoryEnd } from "./memory.js";
export { splitChannel, type Announcement } from "./split.js";
export { streamChannel, type StreamPair } from "./stream.js";
export { all, settled, type Ended, type Sourced } from "./combine.js";
export { held } from "./held.js";
export {
  portActor,
  type DataMessage,
  type PortActorSpec,
  type PortIn,
  type PortOut,
  type PortPublic,
  type SendMessage,
  type SignalMessage,
} from "./actor.js";
