// ── waiting, but not forever ────────────────────────────────────────────────
//
// A protocol step waits for the peer; a peer that says nothing is a step that has to end. The promise is the
// wait, `ms` is the bound, and `reason` is the sentence a caller reads when it runs out.

/** Resolves with the work, or rejects after `ms` with `reason`. */
export function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
