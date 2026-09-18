// src/remote/gateway.ts
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// src/version.ts
var LIB_VERSION = "0.34.0";

// src/remote/kit.ts
var KIT_LAYOUT = 1;
function versionLine(app, role, proto) {
  return `${app.name}-${role} ${app.version} posipaki ${LIB_VERSION} proto ${proto} layout ${KIT_LAYOUT}`;
}
function parseHostVersion(text) {
  const at = text.indexOf("@");
  if (at <= 0 || at === text.length - 1)
    return;
  return { name: text.slice(0, at), version: text.slice(at + 1) };
}

// src/remote/protocols/json1.ts
var VERSION = "json.v1";

// src/remote/stdio.ts
import * as readline from "node:readline";
var OUTPUT_KEY = "$fd";
var ERROR_KEY = "$error";

class StdioWireError extends Error {
  constructor(message) {
    super(message);
    this.name = "StdioWireError";
  }
}
function outputFrame(fd, data) {
  return JSON.stringify({ [OUTPUT_KEY]: fd, data });
}
function errorFrame(reason) {
  return JSON.stringify({ [ERROR_KEY]: reason });
}
function peerGone(code) {
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END" || code === "ERR_STREAM_ALREADY_FINISHED";
}
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

class LineTransport {
  streams;
  pvtOnMessage = null;
  pvtOnClose = null;
  pvtClosed = false;
  pvtClosing = null;
  constructor(streams) {
    this.streams = streams;
    const lines = readline.createInterface({ input: streams.read });
    lines.on("line", (line) => {
      if (this.pvtOnMessage && !this.pvtClosed)
        this.pvtOnMessage(line);
    });
    lines.on("close", () => {
      this.pvtOnClose?.();
      this.close();
    });
    streams.read.on("error", () => {
      this.close();
    });
    streams.write.on("error", () => {
      this.close();
    });
  }
  get closed() {
    return this.pvtClosed;
  }
  get hasHandler() {
    return this.pvtOnMessage !== null;
  }
  onMessage(handler) {
    if (this.pvtClosed)
      throw new StdioWireError("stdio transport: closed");
    if (this.pvtOnMessage !== null) {
      throw new StdioWireError("stdio transport: handler already set — call removeHandler()");
    }
    this.pvtOnMessage = handler;
  }
  removeHandler() {
    const previous = this.pvtOnMessage;
    this.pvtOnMessage = null;
    return previous;
  }
  onClose(handler) {
    this.pvtOnClose = handler;
  }
  send(frame) {
    if (this.pvtClosed) {
      return Promise.resolve();
    }
    const line = frame.endsWith(`
`) ? frame : `${frame}
`;
    return new Promise((resolve, reject) => {
      try {
        this.streams.write.write(line, (err) => {
          if (!err)
            return resolve();
          const code = err.code;
          if (peerGone(code)) {
            return resolve();
          }
          reject(new StdioWireError(`stdio transport: ${err.message}`));
        });
      } catch (err) {
        reject(new StdioWireError(`stdio transport: ${errorText(err)}`));
      }
    });
  }
  async close() {
    this.pvtClosing ??= this.pvtClose();
    await this.pvtClosing;
  }
  async pvtClose() {
    await Promise.resolve();
    this.pvtClosed = true;
    try {
      this.streams.read.destroy?.();
    } catch {}
    try {
      if (!this.streams.write.writableEnded)
        this.streams.write.end();
    } catch {}
  }
}

// src/remote/transports/fifo.ts
import { open } from "node:fs/promises";
import * as readline2 from "node:readline";

class FifoUtf8NlineTransport {
  readFd;
  writeFd;
  rl;
  rs;
  ws;
  pvtOnMessage = null;
  pvtOnClose = null;
  closed = false;
  closingPromise = null;
  pvtError = null;
  constructor(opts) {
    this.readFd = opts.readFd ?? null;
    this.writeFd = opts.writeFd ?? null;
    if (this.readFd) {
      this.rs = this.readFd.createReadStream({ encoding: "utf-8" });
      this.rl = readline2.createInterface({ input: this.rs });
      this.rl.on("line", (line) => {
        if (this.pvtOnMessage && !this.closed)
          this.pvtOnMessage(line);
      });
      this.rl.on("close", () => {
        this.pvtOnClose?.();
        this.close();
      });
      this.rs.on("error", (err) => {
        this.pvtError = err;
        this.close();
      });
    } else {
      this.rs = null;
      this.rl = null;
    }
    if (this.writeFd) {
      this.ws = this.writeFd.createWriteStream({ encoding: "utf-8" });
      this.ws.on("error", (err) => {
        this.pvtError = err;
        this.close();
      });
    } else {
      this.ws = null;
    }
  }
  static openReaderFd(readFd) {
    return new FifoUtf8NlineTransport({ readFd });
  }
  static openWriterFd(writeFd) {
    return new FifoUtf8NlineTransport({ writeFd });
  }
  static fromFds(readFd, writeFd) {
    return new FifoUtf8NlineTransport({ readFd, writeFd });
  }
  static beginConnect(readPath, writePath) {
    const readFdPromise = open(readPath, "r");
    const transport = readFdPromise.then(async (readFd) => {
      const writeFd = await open(writePath, "w");
      return FifoUtf8NlineTransport.fromFds(readFd, writeFd);
    });
    return { transport };
  }
  static async connect(readPath, writePath) {
    const readFdPromise = open(readPath, "r");
    const writeFd = await open(writePath, "w");
    const readFd = await readFdPromise;
    return FifoUtf8NlineTransport.fromFds(readFd, writeFd);
  }
  get canSend() {
    return this.writeFd !== null && !this.closed;
  }
  onMessage(handler) {
    if (this.closed)
      throw new Error("FifoUtf8NlineTransport: closed");
    if (this.readFd === null)
      throw new Error("FifoUtf8NlineTransport: not a reader");
    if (this.pvtOnMessage !== null) {
      throw new Error("FifoUtf8NlineTransport: handler already set — call removeHandler() first");
    }
    this.pvtOnMessage = handler;
  }
  removeHandler() {
    const prev = this.pvtOnMessage;
    this.pvtOnMessage = null;
    return prev;
  }
  onClose(handler) {
    this.pvtOnClose = handler;
  }
  get hasHandler() {
    return this.pvtOnMessage !== null;
  }
  get lastError() {
    return this.pvtError;
  }
  async send(line) {
    if (this.closed)
      throw new Error("FifoUtf8NlineTransport: closed");
    if (this.writeFd === null)
      throw new Error("FifoUtf8NlineTransport: not a writer");
    if (!line.endsWith(`
`))
      line += `
`;
    await this.ws?.write(line);
  }
  async close() {
    this.closingPromise = this.closingPromise || this.pvtClose();
    await this.closingPromise;
    this.closed = true;
  }
  async pvtClose() {
    await Promise.resolve();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.rs) {
      this.rs.destroy();
      this.rs = null;
    }
    if (this.ws) {
      await new Promise((resolve) => {
        try {
          this.ws?.end("", resolve);
        } catch {
          resolve();
        }
      });
      this.ws = null;
    }
    if (this.readFd) {
      try {
        await this.readFd.close();
      } catch {}
      this.readFd = null;
    }
    if (this.writeFd) {
      try {
        await this.writeFd.close();
      } catch {}
      this.writeFd = null;
    }
  }
}

// src/remote/gateway.ts
var run = promisify(execFile);
var GATEWAY_FAILED = 1;
function errorText2(err) {
  return err instanceof Error ? err.message : String(err);
}
function flagValue(argv, name) {
  const prefix = `--${name}=`;
  return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}
function positiveInt(value) {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}
function gatewayBoot(argv) {
  const worker = argv[0];
  if (worker === undefined || worker.startsWith("--")) {
    throw new Error("no <payload>: the gateway relays to a payload, named as its first argument");
  }
  const host = flagValue(argv, "host-version");
  const app = host === undefined ? undefined : parseHostVersion(host);
  if (app === undefined) {
    throw new Error("no --host-version=<app>@<version>: the gateway says whose payload it relays");
  }
  return {
    app,
    ...flagValue(argv, "env") === undefined ? {} : { env: flagValue(argv, "env") },
    poolSize: positiveInt(flagValue(argv, "pool-size")),
    worker
  };
}
function abandon() {
  process.exit(GATEWAY_FAILED);
}
async function fail(wire, reason) {
  process.stderr.write(`gateway: ${reason}
`);
  try {
    await wire.send(errorFrame(reason));
  } catch {}
}
function forwardOutput(stream, wire, fd) {
  stream.setEncoding("utf-8");
  stream.on("data", (chunk) => {
    wire.send(outputFrame(fd, chunk)).catch(() => {});
  });
}
async function runGateway(argv = process.argv.slice(2)) {
  if (argv.includes("--version")) {
    const host = flagValue(argv, "host-version");
    const app = (host === undefined ? undefined : parseHostVersion(host)) ?? {
      name: "posipaki",
      version: "-"
    };
    process.stdout.write(`${versionLine(app, "gateway", VERSION)}
`);
    return 0;
  }
  const wire = new LineTransport({ read: process.stdin, write: process.stdout });
  let booted;
  try {
    booted = gatewayBoot(argv);
  } catch (err) {
    await fail(wire, errorText2(err));
    abandon();
  }
  const { env = "unnamed", poolSize, worker } = booted;
  const dir = await mkdtemp(join(tmpdir(), `posipaki-${env.replace(/\//g, "-")}-`));
  const fifoIn = join(dir, "in");
  const fifoOut = join(dir, "out");
  let child = null;
  let fifo = null;
  const teardown = async () => {
    child?.kill();
    await fifo?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  const onTerminate = () => {
    teardown().catch(() => {}).then(() => process.exit(GATEWAY_FAILED));
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.on(signal, onTerminate);
  try {
    await run("mkfifo", ["-m", "600", fifoIn, fifoOut]);
  } catch (err) {
    await fail(wire, `cannot create the environment's fifos: ${errorText2(err)}`);
    await teardown();
    abandon();
  }
  const connection = FifoUtf8NlineTransport.beginConnect(fifoIn, fifoOut);
  const workerArgs = [
    worker,
    `--env=${env}`,
    ...poolSize === undefined ? [] : [`--pool-size=${poolSize}`],
    `--fifo-in=${fifoIn}`,
    `--fifo-out=${fifoOut}`
  ];
  const workerProc = spawn(process.execPath, workerArgs, { stdio: ["ignore", "pipe", "pipe"] });
  child = workerProc;
  forwardOutput(workerProc.stdout, wire, 1);
  forwardOutput(workerProc.stderr, wire, 2);
  const exited = new Promise((settle) => {
    workerProc.once("exit", (code2) => settle(code2 ?? 0));
  });
  try {
    fifo = await Promise.race([
      connection.transport,
      exited.then((code2) => {
        throw new Error(`the payload exited with code ${code2} before it opened its channel`);
      })
    ]);
  } catch (err) {
    await fail(wire, errorText2(err));
    await teardown();
    abandon();
  }
  const relay = fifo;
  relay.onMessage((line) => {
    wire.send(line).catch(() => {});
  });
  wire.onMessage((line) => {
    relay.send(line).catch(() => {});
  });
  wire.onClose(() => {
    child?.kill();
  });
  const code = await exited;
  await teardown();
  await wire.close();
  return code;
}

// src/remote/gateway-cli.ts
(async () => {
  try {
    process.exitCode = await runGateway();
  } catch (err) {
    process.stderr.write(`gateway: ${err instanceof Error ? err.message : String(err)}
`);
    process.exitCode = GATEWAY_FAILED;
  }
})();
