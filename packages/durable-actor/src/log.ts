// ── a log as a channel ──────────────────────────────────────────────────────
//
// The journal's shape without a file: what is sent is appended and handed to every reader of the log, so a
// writer and a reader see one sequence.  In the harness this is `journalChannel(path)`; a peer's stream is the
// other implementation of the same channel.
//
// One log can have many channels — that is what makes it the shared thing two followers read while one writer
// appends.

import { ChannelClosed, type Channel } from 'posipaki/port';


/** One log: what it holds, who reads it, and the writers' door. */
export interface Log<R> {
  /** A channel over this log: what it holds arrives first, then every append. */
  channel(): Channel<R, string>;
}

/** A log holding what it was given.  Any number of channels over it see one sequence. */
export function openLog<R>(initial: R[] = []): Log<R> {
  const records: R[] = [...initial];
  const readers = new Set<(record: R) => void>();

  return {
    channel(): Channel<R, string> {
      let ended: string | null = null;
      return {
        async send(record: R): Promise<void> {
          if (ended !== null) throw new ChannelClosed(ended);
          records.push(record);
          for (const reader of readers) reader(record);
        },
        onFrame(handler) {
          // What the log already holds arrives first: the log is the buffer, not some writer's memory.
          for (const record of records) handler(record);
          readers.add(handler);
          return () => readers.delete(handler);
        },
        onClose: () => () => {},
        onError: () => () => {},
        close: async (reason = 'the log is closed') => {
          if (ended !== null) return;
          ended = reason;
          readers.clear();
        },
        info: { records: records.length },
        control: () => {},
      };
    },
  };
}

/** A log of its own, with a channel over it: the one-reader case. */
export function logChannel<R>(initial: R[] = []): Channel<R, string> {
  return openLog(initial).channel();
}
