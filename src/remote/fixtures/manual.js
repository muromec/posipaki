import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const args = process.argv.slice(2);

const fifoIn = args.find((a) => a.startsWith("--fifo-in="))?.slice("--fifo-in=".length);
const fifoOut = args.find((a) => a.startsWith("--fifo-out="))?.slice("--fifo-out=".length);

if (!fifoIn || !fifoOut) process.exit(1);

const writeFd = await open(fifoIn, "w");
const readFd = await open(fifoOut, "r");

await writeFd.write('{"$proto":"json.v1"}\n');

const rs = createReadStream("", { fd: readFd.fd, encoding: "utf-8", autoClose: false });
const rl = createInterface({ input: rs });

await new Promise((resolve) => {
  rl.once("line", resolve);
});
await writeFd.write('{"$state":{"pings":0}}\n');

rl.on("line", async (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.$msg) {
      const body = msg.$msg.body;
      if (body.type === "PING") {
        await writeFd.write(
          JSON.stringify({
            $msg: { type: "PONG", fromName: "child", body: { type: "PONG", count: body.count } },
          }) + "\n",
        );
      } else if (body.type === "STOP") {
        await writeFd.write(
          JSON.stringify({
            $exit: { code: 0, state: { pings: body.count || 0 } },
          }) + "\n",
        );
        rl.close();
        rs.destroy();
        await writeFd.close();
        process.exit(0);
      }
    }
  } catch {}
});
