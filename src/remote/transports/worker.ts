/* eslint-disable unicorn/prefer-add-event-listener, unicorn/require-post-message-target-origin */
// ── Worker transport ────────────────────────────────────────────────────────────
//
// Moves frame objects directly over postMessage.  postMessage structured-clones
// the frame object, so there is no JSON encode/decode — this transport implements
// Channel directly (not StringTransport).  Structured clone is the worker's
// native encoding, named by WORKER_VERSION.

import type { Channel } from "../channel.js";

/** The worker encoding: native structured clone (no JSON). */
export const WORKER_VERSION = "clone.v1";

/**
 * The subset of a worker the transport needs.  The main-thread `Worker` and the
 * worker-global `self` both satisfy it; `terminate` is present only on the
 * main-thread side.
 */
export interface WorkerLike {
  postMessage(data: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  terminate?(): void;
}

export class WorkerTransport implements Channel {
  private worker: WorkerLike;
  private pvtOnMessage: ((frame: Record<string, unknown>) => void) | null = null;
  private pvtOnClose: (() => void) | null = null;
  private closed = false;

  constructor(worker: WorkerLike) {
    this.worker = worker;
    worker.onmessage = (event) => {
      if (this.pvtOnMessage && !this.closed) {
        this.pvtOnMessage(event.data as Record<string, unknown>);
      }
    };
    // An uncaught error in the worker is the closest thing to an abrupt drop.
    if ("onerror" in worker) {
      worker.onerror = () => {
        this.closed = true;
        this.pvtOnClose?.();
      };
    }
  }

  get canSend(): boolean {
    return !this.closed;
  }

  onMessage(handler: (frame: Record<string, unknown>) => void): void {
    if (this.closed) throw new Error("WorkerTransport: closed");
    if (this.pvtOnMessage !== null) {
      throw new Error("WorkerTransport: handler already set — call removeHandler() first");
    }
    this.pvtOnMessage = handler;
  }

  removeHandler(): ((frame: Record<string, unknown>) => void) | null {
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

  async send(frame: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error("WorkerTransport: closed");
    this.worker.postMessage(frame);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate?.();
  }
}
