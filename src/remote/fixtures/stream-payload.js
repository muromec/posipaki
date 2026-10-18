// ── a payload that reads and writes streams ────────────────────────────────
//
// The far side of the stream tests: an actor that is sent an ordinary message with a stream in
// its body, reads it, and answers with the digest — and one that answers with a stream of its
// own making, so both directions cross the wire the way an application uses them.

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
  name: "streamer",
  setup: () => ({}),
  handlers: {
    async HASH(msg) {
      // Two kinds of value arrive the same way: a stream is read to the end as it comes, a blob is
      // asked for its bytes.  Both are the same octets on the same wire.
      const hash = createHash("sha256");
      let bytes = 0;
      let chunks = 0;
      if (typeof msg.file.arrayBuffer === "function") {
        const all = new Uint8Array(await msg.file.arrayBuffer());
        hash.update(all);
        bytes = all.length;
        chunks = 1;
      } else {
        // Read to the end, here, as it arrives: a chunk lost, doubled or reordered changes the
        // digest, and nothing here knows how many chunks there will be.
        for await (const chunk of msg.file) {
          hash.update(chunk);
          bytes += chunk.length;
          chunks += 1;
        }
      }
      await this.emit({ type: "HASHED", digest: new Uint8Array(hash.digest()), bytes, chunks });
    },
    async TAKE(msg) {
      // Nothing is awaited here on purpose: the handler reads the array the message carried, and the
      // values it reports prove every octet was here before the message was handed over.
      const values = [...msg.data];
      await this.emit({ type: "TOOK", kind: msg.data.constructor.name, values });
    },
    async SERVE(msg) {
      // A stream this side makes itself: the caller reads it at its own pace, and the bytes are
      // produced one chunk at a time as they are asked for.
      const file = {
        size: msg.chunks * msg.size,
        async *[Symbol.asyncIterator]() {
          for (let index = 1; index <= msg.chunks; index += 1) {
            yield new Uint8Array(msg.size).fill(index % 256);
          }
        },
      };
      await this.emit({ type: "SERVED", file });
    },
  },
});

serveRemoteActor(reader, fifoArgvSpawner);
