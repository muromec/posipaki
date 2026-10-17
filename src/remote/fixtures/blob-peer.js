// A peer that speaks the blob frames by hand: it reads a blob it was told about, hashes
// what actually arrived, and answers with the count.  Written out rather than imported so
// the wire format is proven from outside the library, the way a second implementation
// would have to read it.  It splits its own lines, because the point of the test is what
// the library costs, not what `node:readline` costs at this frame size.
import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const fifoIn = args.find((a) => a.startsWith("--fifo-in="))?.slice("--fifo-in=".length);
const fifoOut = args.find((a) => a.startsWith("--fifo-out="))?.slice("--fifo-out=".length);
if (!fifoIn || !fifoOut) process.exit(1);

const writeFd = await open(fifoIn, "w");
const readFd = await open(fifoOut, "r");
const say = (frame) => writeFd.write(JSON.stringify(frame) + "\n");

await say({ $proto: "json.v1" });

/** The read in flight: what was asked for, and what has arrived. */
let reading = null;

async function handle(frame) {
  if (frame.$msg) {
    const body = frame.$msg.body ?? {};
    if (body.type === "STOP") {
      await say({ $exit: { code: 0, state: { reads: 1 } } });
      process.exit(0);
    }
    if (body.type === "READ_BLOB") {
      const ref = body.blob?.$b;
      if (!ref) {
        await say({ $msg: { fromName: "peer", body: { type: "BLOB_ERROR", reason: "no blob in the message" } } });
        return;
      }
      reading = {
        id: ref.id,
        declared: ref.size,
        mime: ref.mime,
        name: ref.name,
        seq: 1,
        chunks: [],
        startedAt: performance.now(),
      };
      await say({ $blobAsk: { id: ref.id, seq: reading.seq } });
    }
    return;
  }

  if (reading && frame.$blobData) {
    reading.chunks.push(Buffer.from(frame.$blobData.data, "base64"));
    return;
  }

  if (reading && frame.$blobEnd) {
    const bytes = Buffer.concat(reading.chunks);
    await say({
      $msg: {
        fromName: "peer",
        body: {
          type: "BLOB_OK",
          bytes: bytes.byteLength,
          declared: reading.declared,
          mime: reading.mime,
          name: reading.name,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          chunks: reading.chunks.length,
          endBytes: frame.$blobEnd.bytes,
          ms: Math.round(performance.now() - reading.startedAt),
        },
      },
    });
    reading = null;
    return;
  }

  if (reading && frame.$blobFail) {
    await say({ $msg: { fromName: "peer", body: { type: "BLOB_ERROR", reason: frame.$blobFail.reason } } });
    reading = null;
  }
}

const rs = createReadStream("", { fd: readFd.fd, autoClose: false });
let acc = Buffer.alloc(0);
rs.on("data", (chunk) => {
  acc = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]);
  for (;;) {
    const at = acc.indexOf(0x0a);
    if (at < 0) return;
    const line = acc.subarray(0, at).toString("utf8");
    acc = acc.subarray(at + 1);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(frame);
  }
});
