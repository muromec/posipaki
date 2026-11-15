// ── a file, read from an offset ─────────────────────────────────────────────
//
// A read names where it starts and answers with what the file holds from there, so a reader that has read once
// asks for the rest rather than the whole file again.
//
// A file that is not there answers nothing: it may be written later.  Any other failure reaches `onError`.

import { open } from 'node:fs/promises';

import { ChannelClosed, type Channel } from '../../channel.js';

/** Where a read starts: the octets before it have already been read. */
export interface FileRead {
  from: number;
}

/** What a read found: the octets from that offset, and where the next read starts. */
export interface FileBytes {
  from: number;
  next: number;
  bytes: Uint8Array;
}

/** A message a read channel carries, either way: what is asked, and what came back. */
export type FileMessage = FileRead | FileBytes;

/** True for a path that is not there, which a reader treats as nothing to read yet. */
function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** The file at `path`, read from wherever a caller says.  Its end is the caller's, not the file's. */
export function readBinaryFile(path: string): Channel<FileMessage, string> {
  const readers = new Set<(frame: FileMessage) => void>();
  const failers = new Set<(error: unknown) => void>();
  let ended: string | null = null;

  return {
    async send({ from }: FileRead): Promise<void> {
      if (ended !== null) throw new ChannelClosed(ended);
      let handle;
      try {
        handle = await open(path, 'r');
      } catch (error) {
        if (isMissing(error)) return;
        for (const failer of failers) failer(error);
        return;
      }
      try {
        const { size } = await handle.stat();
        if (size <= from) return;
        const buffer = new Uint8Array(size - from);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
        // Nothing to hand over is not a frame: a read that found no new octets says nothing.
        if (bytesRead === 0) return;
        const frame: FileBytes = {
          from,
          next: from + bytesRead,
          bytes: buffer.subarray(0, bytesRead),
        };
        for (const reader of readers) reader(frame);
      } finally {
        await handle.close();
      }
    },
    onFrame(handler) {
      readers.add(handler);
      return () => readers.delete(handler);
    },
    // A read has no far end to close it, so only this side can, and the side that closed it does not hear.
    onClose: () => () => {},
    onError(handler) {
      failers.add(handler);
      return () => failers.delete(handler);
    },
    close: async (reason = 'the file is closed') => {
      if (ended !== null) return;
      ended = reason;
      readers.clear();
    },
    info: { path },
    // This side is told to read, it does not push: nothing is ever standing on it.
    hasFrames: async () => false,
    control: () => {},
  };
}
