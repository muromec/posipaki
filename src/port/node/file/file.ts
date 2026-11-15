// ── a file, both ways ───────────────────────────────────────────────────────
//
// One channel over one path: what is sent is appended, and what the file gained since this channel last read
// arrives as a frame.  A channel opened on a file that already holds something reads it on the first
// subscription, so a file written while nobody read is still read.
//
// A write by anybody in this process wakes every channel on the path, this one included; that is how a sent
// frame comes back to the same reader, and how two channels on one journal see one sequence.

import { stat } from 'node:fs/promises';

import { ChannelClosed, type Channel } from '../../channel.js';

import { readBinaryFile, type FileMessage } from './read.js';
import { wakeOn } from './wake.js';
import { writeBinaryFile } from './write.js';

/** Where this channel has read up to: every frame it has handed over ends at this offset. */
export function fileChannel(path: string): Channel<Uint8Array, string> {
  const read = readBinaryFile(path);
  const write = writeBinaryFile(path);
  const readers = new Set<(bytes: Uint8Array) => void>();
  const failers = new Set<(error: unknown) => void>();
  let cursor = 0;
  let ended: string | null = null;
  /** One read at a time: two racing reads would hand the same octets over twice. */
  let reading: Promise<void> = Promise.resolve();

  read.onFrame((frame: FileMessage) => {
    if (!('bytes' in frame)) return;
    cursor = frame.next;
    for (const reader of readers) reader(frame.bytes);
  });
  read.onError((error) => {
    for (const failer of failers) failer(error);
  });

  /** How many reads are in flight: a read that is running is a frame that is coming. */
  let inFlight = 0;

  const again = async (): Promise<void> => {
    if (ended !== null) return;
    inFlight += 1;
    try {
      await read.send({ from: cursor });
    } finally {
      inFlight -= 1;
    }
  };
  const restart = (): Promise<void> => (reading = reading.then(again, again));
  const leave = wakeOn(path, restart);

  return {
    async send(bytes: Uint8Array): Promise<void> {
      if (ended !== null) throw new ChannelClosed(ended);
      // The append wakes this channel too, so what was written is read back the way any other frame is.
      await write.send(bytes);
    },
    onFrame(handler) {
      readers.add(handler);
      void restart();
      return () => readers.delete(handler);
    },
    // A file has no far end to close it, so only this side can, and the side that closed it does not hear.
    onClose: () => () => {},
    onError(handler) {
      failers.add(handler);
      return () => failers.delete(handler);
    },
    close: async (reason = 'the file is closed') => {
      if (ended !== null) return;
      ended = reason;
      leave();
      readers.clear();
      await read.close(reason);
      await write.close(reason);
    },
    info: { path },
    /**
     * Whether a frame is standing: bytes past this cursor.
     *
     * A file can always answer, because its length is a fact — and a read in flight does not change the answer,
     * since the octets it is fetching are already in the file and past the cursor.  It grows a moment later and
     * the answer becomes `true` again.
     */
    async hasFrames(): Promise<boolean> {
      if (ended !== null) return false;
      const size = await stat(path).then((found) => found.size, () => 0);
      return size > cursor;
    },
    control: () => {},
  };
}
