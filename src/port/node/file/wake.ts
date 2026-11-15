// ── a write, heard by every reader of the path ───────────────────────────────
//
// The file is the queue: a reader of a path learns that there is more to read from a writer of that path, in
// this process and no other.  Nothing watches the file, so a write by another process is read at the next write
// this one makes.

/** Every channel reading one path, and how it is woken. */
const waiting = new Map<string, Set<() => Promise<void>>>();

/** Wake whoever reads this path, after one of them has written to it. */
export async function woke(path: string): Promise<void> {
  for (const wake of waiting.get(path) ?? []) await wake();
}

/** Have `wake` called whenever this path is written, until the returned function is called. */
export function wakeOn(path: string, wake: () => Promise<void>): () => void {
  const known = waiting.get(path);
  if (known === undefined) waiting.set(path, new Set([wake]));
  else known.add(wake);
  return () => {
    const readers = waiting.get(path);
    if (readers === undefined) return;
    readers.delete(wake);
    if (readers.size === 0) waiting.delete(path);
  };
}
