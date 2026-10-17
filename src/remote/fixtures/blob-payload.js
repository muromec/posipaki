// ── a payload that reads bytes ─────────────────────────────────────────────
//
// The far side of the blob tests: an actor that is sent a message with bytes in it, reads
// them, and answers with a message carrying the digest.  Ordinary messages on both legs —
// what an application actually does — so nothing here depends on the reflection surface.

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
  handlers: {
    async HASH(msg) {
      // The bytes are read here, on the far side of the wire, and the digest goes back in
      // the body of an ordinary message: a chunk lost, doubled or reordered changes it.
      const bytes = new Uint8Array(await msg.bytes);
      await this.emit({ type: "HASHED", digest: new Uint8Array(createHash("sha256").update(bytes).digest()) });
    },
  },
});

// A hundred megabytes is a test, not an accident.  The bound on what will be read belongs to
// the side that reads, so this reader says how much it is willing to hold.
serveRemoteActor(reader, fifoArgvSpawner, undefined, { maxBytes: 256 * 1024 * 1024 });
