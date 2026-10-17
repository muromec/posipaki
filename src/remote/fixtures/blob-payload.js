// ── a payload that reads bytes ─────────────────────────────────────────────
//
// Serves one actor whose only job is the far side of the blob tests: it reads what it is
// handed and answers with the digest, so the proof that a file arrived whole is computed
// where it landed rather than by the side that sent it.

import { createHash } from "node:crypto";

let defineActor;
let serveRemoteActor;
let fifoArgvSpawner;

try {
  ({ defineActor } = await import("../../../dist/index.js"));
  ({ serveRemoteActor } = await import("../../../dist/remote/index.js"));
  ({ fifoArgvSpawner } = await import("../../../dist/remote/node.js"));
} catch {
  console.error(
    "Posipaki remote actor failed to start.\nFailed to import, no built version of the library found.\nRun npm run build or bun run build first.\nExiting now",
  );
  process.exit(1);
}

const reader = defineActor({
  name: "reader",
  setup: () => ({}),
  handlers: {},
  $reflectionMethods: {
    async "probe.sha256"(value) {
      // Read here, on the far side of the wire, and the digest goes back as bytes of its
      // own: a chunk lost, doubled or reordered changes it.
      const bytes = new Uint8Array(await value);
      return new Uint8Array(createHash("sha256").update(bytes).digest());
    },
  },
});

// A hundred megabytes is a test, not an accident.  The bound on what will be read belongs to
// the side that reads, so this reader says how much it is willing to hold.
serveRemoteActor(reader, fifoArgvSpawner, undefined, { maxBytes: 256 * 1024 * 1024 });
