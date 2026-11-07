// ── the seam over a port ────────────────────────────────────────────────────
//
// A spawner from the port layer hands up a raw channel: octets for a fifo, a socket or a stdio pair, whole
// messages for a websocket.  The seam's frames sit four steps above that — split, decode, agree, and the
// reader shape — and this file is those steps in one place, so a spawner says only what medium it is.
//
// The last step belongs to the seam: `Channel<F>` gives each reader its own unsubscribe and tells a close
// why; `FrameChannel` returns the unsubscribe from `onMessage` and says nothing on `onClose`.  Both ends of
// that difference are published, so it is bridged here rather than changed on either side.
//
// `Channel` also has an error of its own, and `FrameChannel` has none: a wire that fails is heard here as the
// close that always follows it, which is what the seam has always heard.

import type { Channel, Delivered, Part } from "../port/index.js";
import { handshake, json1, readFrame, splitChannel } from "../port/index.js";
import type { FrameChannel } from "../types.js";
import type { ClientSpawner } from "./client.js";
import { announcedOctets, VERSION } from "./protocols/json1.js";

/** How many octets follow this line on the seam: a `$chunk` head says, and nothing else does. */
export function seamAnnounced(line: string): number | null {
  return announcedOctets(readFrame(line));
}

/** What a connection may set on its way up. */
export interface JsonSeamOptions {
  /** How long to wait for the peer to say what it speaks. */
  timeoutMs?: number;
}

/**
 * A port's channel, read as the seam's frames.
 *
 * A frame and the octets it announced are one value above the protocol and two facts below it; this is where
 * they separate again, because `FrameChannel` keeps them on two subscriptions.
 */
export function frameChannel(opened: Channel<Delivered>): FrameChannel {
  return {
    send: (frame) => opened.send({ frame, bytes: null }),
    onMessage(handler) {
      return opened.onFrame((value) => {
        if (value.bytes === null) handler(value.frame);
      });
    },
    sendSegment: (frame, bytes) => opened.send({ frame, bytes }),
    onSegment(handler) {
      return opened.onFrame((value) => {
        if (value.bytes !== null) handler(value.frame, value.bytes);
      });
    },
    onClose(handler) {
      opened.onClose(() => handler());
    },
    close: () => opened.close(),
  };
}

/** The steps above a channel of parts, which end at the seam's frames. */
async function overParts(parts: Channel<Part>, options: JsonSeamOptions): Promise<FrameChannel> {
  const agreed = await handshake(json1(parts), { version: VERSION, timeoutMs: options.timeoutMs });
  return frameChannel(agreed);
}

/**
 * A spawner whose channel carries octets: a fifo, a socket, a stdio pair.
 *
 * The spawner says only how to open its medium.  Splitting, decoding and agreeing are the same work for all
 * of them, and a caller that wired them itself would be wiring three adapters where the medium was the only
 * thing that differed.
 */
export function jsonSeam<Args = unknown>(
  spawner: (args: Args) => Promise<Channel<Uint8Array>>,
  options: JsonSeamOptions = {},
): ClientSpawner<Args> {
  return async (args) => overParts(splitChannel(await spawner(args), seamAnnounced), options);
}

/** A spawner whose channel already carries parts: a websocket moves whole messages and splits nothing. */
export function jsonSeamParts<Args = unknown>(
  spawner: (args: Args) => Promise<Channel<Part>>,
  options: JsonSeamOptions = {},
): ClientSpawner<Args> {
  return async (args) => overParts(await spawner(args), options);
}
