// ── A channel ───────────────────────────────────────────────────────────────
//
// Carries values of one type between two ends.  The type parameter is what crosses: bytes, a line and the
// octets it announced, a decoded frame.  A medium produces one; a protocol adapter wraps one into another.
//
// It ends one of three ways, and each has its own callback:
//
//   close()   this side ends it; the far end hears a close, this side's callers hear nothing
//   onClose   the far end is gone, with the reason it gave
//   onError   the wire failed; once, and always before onClose
//
// `close()` is idempotent.  `send()` rejects once the channel is over, from either side.

/**
 * A line of a channel that carries lines, and the octets it announced.
 *
 * A line may announce octets after it, as a stream chunk does on the remote seam, so a part is the line and
 * what it announced.  A medium that moves whole messages, a websocket for instance, produces parts with no
 * octets.  A byte medium produces none until the splitter has run.
 */
export interface Part {
  /** One line, without its terminator. */
  line: string;
  /** The octets the line announced, when it announced any. */
  bytes: Uint8Array | null;
}

/** Values of one type, between two ends. */
export interface Channel<F> {
  /**
   * Put a frame on it.
   *
   * Rejects when the channel is over, from either side: there is no reader left, and a resolved promise
   * would say the frame had been taken.
   */
  send(frame: F): Promise<void>;
  /** A frame arrived.  The returned function stops this reader and no other. */
  onFrame(handler: (frame: F) => void): () => void;
  /** The far end closed, and said why.  Once, after any frames already read. */
  onClose(handler: (reason: string) => void): () => void;
  /** The wire failed.  Once, and always followed by a close. */
  onError(handler: (error: unknown) => void): () => void;
  /**
   * Close it from this side.
   *
   * Idempotent: a second call does nothing.  The far end hears a close; the callers on this side do not,
   * because they are the ones who asked.
   */
  close(reason?: string): Promise<void>;
}

/** What is thrown when a frame is sent on a channel that is over. */
export class ChannelClosed extends Error {
  constructor(reason: string) {
    super(`the channel is closed: ${reason}`);
    this.name = "ChannelClosed";
  }
}
