// ── test-setup ──────────────────────────────────────────────────────────────
// Preloaded before any test file runs.

const realVitest = await import('vitest');
// ── vitest shim ────────────────────────────────────────────────────────────
Object.assign(realVitest.vi, {
    stubGlobal(name: string, value: unknown) {
      (globalThis as Record<string, unknown>)[name] = value;
    },
    async runAllTimersAsync() {
      this.runAllTimers();
      return await Promise.resolve();
    },
    async advanceTimersByTimeAsync(t: number) {
      this.advanceTimersByTime(t);
      return await Promise.resolve();
    },
    async waitFor(
      fn: () => void | Promise<void>,
      _opts?: { timeout?: number; interval?: number },
    ): Promise<void> {
      const timeout = _opts?.timeout ?? 1000;
      const interval = _opts?.interval ?? 10;
      const deadline = Date.now() + timeout;
      while (true) {
        try {
          await fn();
          return;
        } catch {
          if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeout}ms`);
          await new Promise(r => setTimeout(r, interval));
        }
      }
    },
});

// bun is not mocking it, so we don't use it
delete globalThis.setImmediate
