// ── Transport ──────────────────────────────────────────────────────────────
//
// A transport moves encoded frames (JSON strings, one protocol object each)
// between the server and client sides of the remote-actor seam. Framing and
// serialization are the transport's concern; the protocol layer above it
// deals only in encoded frames.
//
// The contract is deliberately small: send, a single onMessage handler with
// an explicit removeHandler (mirroring the strict handler lifecycle of the
// FIFO transport), and close.

export interface Transport {
  send(frame: string): void | Promise<void>;
  onMessage(handler: (frame: string) => void): void;
  removeHandler(): void;
  close(): Promise<void>;
}
