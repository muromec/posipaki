// ── FIFO transport ─────────────────────────────────────────────────────────
//
// Newline-delimited UTF-8 over named fifos.  Strict handler lifecycle:
// onMessage() throws if a handler is already set; call removeHandler() first.

import { open, type FileHandle } from "node:fs/promises";
import type { ReadStream, WriteStream } from "node:fs";
import * as readline from "node:readline";
import type { StringTransport } from "../channel.js";

export class FifoUtf8NlineTransport implements StringTransport {
  private readFd: FileHandle | null;
  private writeFd: FileHandle | null;
  private rl: readline.Interface | null;
  private rs: ReadStream | null;
  private ws: WriteStream | null;
  private pvtOnMessage: ((line: string) => void) | null = null;
  private pvtOnClose: (() => void) | null = null;
  private closed = false;
  private closingPromise: Promise<void> | null = null;
  private pvtError: Error | null = null;

  private constructor(opts: { readFd?: FileHandle; writeFd?: FileHandle }) {
    this.readFd = opts.readFd ?? null;
    this.writeFd = opts.writeFd ?? null;

    if (this.readFd) {
      this.rs = this.readFd.createReadStream({ encoding: "utf-8" });
      this.rl = readline.createInterface({ input: this.rs });

      this.rl.on("line", (line) => {
        if (this.pvtOnMessage && !this.closed) this.pvtOnMessage(line);
      });

      this.rl.on("close", () => {
        this.pvtOnClose?.();
        this.close();
      });

      this.rs.on("error", (err: Error) => {
        this.pvtError = err;
        this.close();
      });
    } else {
      this.rs = null;
      this.rl = null;
    }

    if (this.writeFd) {
      this.ws = this.writeFd.createWriteStream({ encoding: "utf-8" });
      this.ws.on("error", (err: Error) => {
        this.pvtError = err;
        this.close();
      });
    } else {
      this.ws = null;
    }
  }

  // ── factories ──────────────────────────────────────────────────────────

  static openReaderFd(readFd: FileHandle): FifoUtf8NlineTransport {
    return new FifoUtf8NlineTransport({ readFd });
  }

  static openWriterFd(writeFd: FileHandle): FifoUtf8NlineTransport {
    return new FifoUtf8NlineTransport({ writeFd });
  }

  static fromFds(readFd: FileHandle, writeFd: FileHandle): FifoUtf8NlineTransport {
    return new FifoUtf8NlineTransport({ readFd, writeFd });
  }

  // ── bidirectional connection ───────────────────────────────────────────

  /**
   * Start opening a bidirectional connection.  Opens readPath for reading
   * in the background, returns a promise.  The caller should do whatever
   * setup is needed to unblock the read (e.g. spawn a process that opens
   * readPath for writing), then await the returned transport.
   *
   * The transport itself is built only once both directions are open.  A read
   * stream created while no writer exists on its fifo is handed an immediate
   * end-of-stream by some runtimes (bun), which closes a channel that has not
   * carried a byte yet — so the writes side is opened before the reader exists.
   */
  static beginConnect(
    readPath: string,
    writePath: string,
  ): { transport: Promise<FifoUtf8NlineTransport> } {
    const readFdPromise = open(readPath, "r");

    const transport = readFdPromise.then(async (readFd) => {
      const writeFd = await open(writePath, "w");
      return FifoUtf8NlineTransport.fromFds(readFd, writeFd);
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
   * opens).  Built like `beginConnect`: the transport exists only after both
   * directions do.
   */
  static async connect(readPath: string, writePath: string): Promise<FifoUtf8NlineTransport> {
    const readFdPromise = open(readPath, "r");
    const writeFd = await open(writePath, "w");
    const readFd = await readFdPromise;
    return FifoUtf8NlineTransport.fromFds(readFd, writeFd);
  }

  // ── public API ─────────────────────────────────────────────────────────

  get canSend(): boolean {
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

  onClose(handler: () => void): void {
    this.pvtOnClose = handler;
  }

  get hasHandler(): boolean {
    return this.pvtOnMessage !== null;
  }

  get lastError(): Error | null {
    return this.pvtError;
  }

  async send(line: string): Promise<void> {
    if (this.closed) throw new Error("FifoUtf8NlineTransport: closed");
    if (this.writeFd === null) throw new Error("FifoUtf8NlineTransport: not a writer");
    if (!line.endsWith("\n")) line += "\n";
    await this.ws?.write(line);
  }

  async close(): Promise<void> {
    this.closingPromise = this.closingPromise || this.pvtClose();
    await this.closingPromise;
    this.closed = true;
  }

  private async pvtClose(): Promise<void> {
    // tranfser control back to caller
    // so they can capture the promise reference
    // and prevent reentry
    await Promise.resolve();

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.rs) {
      this.rs.destroy();
      this.rs = null;
    }
    if (this.ws) {
      await new Promise<void>((resolve) => {
        try {
          this.ws?.end("", resolve);
        } catch {
          resolve();
        }
      });
      this.ws = null;
    }

    if (this.readFd) {
      try {
        await this.readFd.close();
      } catch {}
      this.readFd = null;
    }
    if (this.writeFd) {
      try {
        await this.writeFd.close();
      } catch {}
      this.writeFd = null;
    }
  }
}
