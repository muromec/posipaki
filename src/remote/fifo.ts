// ── FIFO transport ─────────────────────────────────────────────────────────
//
// Opens a named fifo for line-delimited read/write.  Uses raw fd open to
// avoid the async-open behavior of createReadStream which causes deadlocks.

import { open, type FileHandle } from "node:fs/promises";
import * as readline from "node:readline";

export class FifoTransport {
  private readFd: FileHandle;
  private writeFd: FileHandle;
  private rl: readline.Interface;
  private pvtOnMessage: ((line: string) => void) | null = null;
  private pvtOnClose: (() => void) | null = null;
  private closed = false;

  private constructor(
    readFd: FileHandle,
    writeFd: FileHandle,
    rl: readline.Interface,
  ) {
    this.readFd = readFd;
    this.writeFd = writeFd;
    this.rl = rl;

    this.rl.on("line", (line) => {
      if (this.pvtOnMessage && !this.closed) this.pvtOnMessage(line);
    });

    this.rl.on("close", () => {
      this.closed = true;
      if (this.pvtOnClose) this.pvtOnClose();
    });
  }

  static async open(
    path: string,
    mode: "reader" | "writer" = "reader",
  ): Promise<FifoTransport> {
    let readFd: FileHandle;
    let writeFd: FileHandle;

    if (mode === "reader") {
      // Open read-end first (blocks until writer)
      readFd = await open(path, "r");
      writeFd = await open(path, "w");
    } else {
      // Open write-end first (blocks until reader)
      writeFd = await open(path, "w");
      readFd = await open(path, "r");
    }

    // Create readline interface from the raw fd
    // We import createReadStream lazily to avoid issues
    const { createReadStream } = await import("node:fs");
    const rs = createReadStream("", {
      fd: readFd.fd,
      encoding: "utf-8",
      autoClose: false,
    });
    const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });

    // Don't close readFd — the stream uses the fd directly
    return new FifoTransport(readFd, writeFd, rl);
  }

  onMessage(handler: (line: string) => void): void {
    this.pvtOnMessage = handler;
  }

  onClose(handler: () => void): void {
    this.pvtOnClose = handler;
  }

  async send(line: string): Promise<void> {
    if (this.closed) throw new Error("FifoTransport: closed");
    if (!line.endsWith("\n")) line += "\n";
    await this.writeFd.write(line);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
    try { await this.readFd.close(); } catch {}
    try { await this.writeFd.close(); } catch {}
  }
}
