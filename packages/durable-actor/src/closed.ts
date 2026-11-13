// ── a channel that is over ──────────────────────────────────────────────────
//
// The library's own `ChannelClosed` lives behind `posipaki/port`, whose module graph reaches node built-ins — so a
// browser bundling this package would fail on `node:string_decoder`.  This package imports that module for types
// only, and throws its own class, which is the same fact with nothing under it.

/** What is thrown when a frame is sent on a channel that is over. */
export class ChannelClosed extends Error {
  constructor(reason: string) {
    super(`the channel is closed: ${reason}`);
    this.name = 'ChannelClosed';
  }
}
