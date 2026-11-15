// ── a log as a channel ──────────────────────────────────────────────────────
//
// The journal's shape without a file: what is sent is appended, and a reader of the log is given what it already
// holds and then every append.  In the harness this is `journalChannel(path)`; a peer's stream is the other
// implementation of the same channel.
//
// One log can have many channels — that is what makes it the shared thing two followers read while one writer
// appends.  What it cannot do is hand its history to everybody: the history belongs to the reader that arrives
// first, because a channel that replayed it to each new subscriber could never say whether anything was standing.

import { ChannelClosed, type Channel } from 'posipaki/port';

/** One log: what it holds, who reads it, and the writers' door. */
export interface Log<R> {
  /** A channel over this log: what it holds arrives at the first reader, then every append. */
  channel(): Channel<R, string>;
}

/** A log holding what it was given.  Any number of channels over it see one sequence. */
export function openLog<R>(initial: R[] = []): Log<R> {
  const records: R[] = [...initial];
  const readers = new Set<(record: R) => void>();

  return {
    channel(): Channel<R, string> {
      let ended: string | null = null;
      /** Whether the history has gone to its reader: before that it is standing for whoever arrives. */
      let handed = false;

      return {
        async send(record: R): Promise<void> {
          if (ended !== null) throw new ChannelClosed(ended);
          records.push(record);
          for (const reader of [...readers]) reader(record);
        },
        onFrame(handler) {
          readers.add(handler);
          const stop = (): boolean => readers.delete(handler);
          // What the log already holds goes to the first reader of this channel, and to no one after it.
          if (handed) return () => stop();
          handed = true;
          for (const record of records) handler(record);
          return () => stop();
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
        /** What the log holds and has not handed to this channel's reader: standing, until the history is taken. */
        hasFrames: async () => !handed && records.length > 0,
      };
    },
  };
}

/** A log of its own, with a channel over it: the one-reader case. */
export function logChannel<R>(initial: R[] = []): Channel<R, string> {
  return openLog(initial).channel();
}
