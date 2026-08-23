// ── FIFO transport ─────────────────────────────────────────────────────────
//
// Newline-delimited UTF-8 over named fifos.  Strict handler lifecycle:
// onMessage() throws if a handler is already set; call removeHandler() first.

import { open, type FileHandle } from "node:fs/promises";
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import * as readline from "node:readline";

export class FifoUtf8NlineTransport {
  private readFd: FileHandle | null;
  private writeFd: FileHandle | null;
  private rl: readline.Interface | null;
  private rs: ReadStream | null;
  private ws: WriteSteeam | null;
  private pvtOnMessage: ((line: string) => void) | null = null;
  private closed = false;
  private pvtError: Error | null = null;
  private pvtWriter: FifoUtf8NlineTransport | null = null;

  private constructor(opts: { readFd?: FileHandle; writeFd?: FileHandle }) {
    this.readFd = opts.readFd ?? null;
    this.writeFd = opts.writeFd ?? null;

    if (this.readFd) {
      this.rs = createReadStream("", {
        fd: this.readFd.fd,
        encoding: "utf-8",
        autoClose: false,
      });
      this.rl = readline.createInterface({ input: this.rs });

      this.rl.on("line", (line) => {
        if (this.pvtOnMessage && !this.closed) this.pvtOnMessage(line);
      });

      this.rl.on("close", () => {
        this.closed = true;
      });

      this.rs.on("error", (err: Error) => {
        this.pvtError = err;
        if (!this.closed) this.closed = true;
      });

      this.rl.on("error", (err: Error) => {
        this.pvtError = err;
        if (!this.closed) this.closed = true;
      });
    } else {
      this.rs = null;
      this.rl = null;
    }

    if (this.writeFd) {
      this.ws = createWriteStream("", {
        fd: this.writeFd.fd,
        encoding: "utf-8",
        autoclose: false,
      });
    } else {
      this.ws = null;
    }
  }

  // ── factories ──────────────────────────────────────────────────────────

  private static async openReader(path: string): Promise<FifoUtf8NlineTransport> {
    const readFd = await open(path, "r");
    return new FifoUtf8NlineTransport({ readFd });
  }

  private static async openWriter(path: string): Promise<FifoUtf8NlineTransport> {
    const writeFd = await open(path, "w");
    return new FifoUtf8NlineTransport({ writeFd });
  }

  static fromFds(readFd: FileHandle, writeFd: FileHandle): FifoUtf8NlineTransport {
    return new FifoUtf8NlineTransport({ readFd, writeFd });
  }

  // ── bidirectional connection ───────────────────────────────────────────

  private attachWriter(w: FifoUtf8NlineTransport): void {
    this.pvtWriter = w;
  }

  /**
   * Start opening a bidirectional connection.  Opens readPath for reading
   * in the background, returns a promise.  The caller should do whatever
   * setup is needed to unblock the read (e.g. spawn a process that opens
   * readPath for writing), then await the returned transport.
   *
   * Once the read completes, writePath is opened for writing automatically.
   */
  static beginConnect(
    readPath: string,
    writePath: string,
  ): { transport: Promise<FifoUtf8NlineTransport> } {
    const readerPromise = FifoUtf8NlineTransport.openReader(readPath);

    const transport = readerPromise.then(async (reader) => {
      const writer = await FifoUtf8NlineTransport.openWriter(writePath);
      reader.attachWriter(writer);
      return reader;
    });

    return { transport };
  }

  /**
   * Open a bidirectional connection.  Opens writePath for writing first
   * (unblocking the peer's read), starts reading readPath in the
   * background, then awaits both.
   *
   * Use this when you are the side that responds to the peer's beginConnect
   * (i.e. you don't need to interleave any setup between the read and write
   * opens).
   */
  static async connect(readPath: string, writePath: string): Promise<FifoUtf8NlineTransport> {
    const readerPromise = FifoUtf8NlineTransport.openReader(readPath);
    const writer = await FifoUtf8NlineTransport.openWriter(writePath);
    const reader = await readerPromise;
    reader.attachWriter(writer);
    return reader;
  }

  // ── public API ─────────────────────────────────────────────────────────

  get canSend(): boolean {
    if (this.pvtWriter) return this.pvtWriter.canSend;
    return this.writeFd !== null && !this.closed;
  }

  onMessage(handler: (line: string) => void): void {
    if (this.closed) throw new Error("FifoUtf8NlineTransport: closed");
    if (this.readFd === null) throw new Error("FifoUtf8NlineTransport: not a reader");
    if (this.pvtOnMessage !== null) {
      throw new Error("FifoUtf8NlineTransport: handler already set — call removeHandler() first");
    }
    this.pvtOnMessage = handler;
  }

  removeHandler(): ((line: string) => void) | null {
    const prev = this.pvtOnMessage;
    this.pvtOnMessage = null;
    return prev;
  }

  get hasHandler(): boolean {
    return this.pvtOnMessage !== null;
  }

  get lastError(): Error | null {
    return this.pvtError;
  }

  async send(line: string): Promise<void> {
    if (this.pvtWriter) return this.pvtWriter.send(line);
    if (this.closed) throw new Error("FifoUtf8NlineTransport: closed");
    if (this.writeFd === null) throw new Error("FifoUtf8NlineTransport: not a writer");
    if (!line.endsWith("\n")) line += "\n";
    await this.ws.write(line);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.rl) this.rl.close();
    if (this.rs) this.rs.destroy();
    if (this.ws) {
      await new Promise((resolve) => {
        this.ws.end("", resolve);
      });
    }

    if (this.readFd) {
      try {
        await this.readFd.close();
      } catch {}
    }
    if (this.writeFd) {
      try {
        await this.writeFd.close();
      } catch {}
    }
    if (this.pvtWriter) {
      await this.pvtWriter.close();
    }
  }
}
