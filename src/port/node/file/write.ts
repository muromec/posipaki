// ── a file, appended to ─────────────────────────────────────────────────────
//
// What is sent is appended, and every channel reading the same path is woken: a writer is how a reader learns
// that there is more to read.

import { appendFile } from 'node:fs/promises';

import { ChannelClosed, type Channel } from '../../channel.js';

import { woke } from './wake.js';

/** The file at `path`, appended to.  It has nothing to say back, so its frames are `never`. */
export function writeBinaryFile(path: string): Channel<Uint8Array, never> {
  let ended: string | null = null;

  return {
    async send(bytes: Uint8Array): Promise<void> {
      if (ended !== null) throw new ChannelClosed(ended);
      await appendFile(path, bytes);
      await woke(path);
    },
    onFrame: () => () => {},
    onClose: () => () => {},
    onError: () => () => {},
    close: async (reason = 'the file is closed') => {
      if (ended !== null) return;
      ended = reason;
    },
    info: { path },
    // A file being appended to has nothing to hand back.
    hasFrames: async () => false,
    control: () => {},
  };
}
