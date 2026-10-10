// ── unix sockets: a listener, and a client ─────────────────────────────────
//
// A local socket as a medium for the reactor: the listener binds a path, takes one connection at a time
// and hands it on; the client side is one call.  The medium brings no framing of its own — a socket is a
// duplex stream, and LineTransport already carries newline-delimited frames over one.

import { chmod, stat, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";

import type { Connection, Listener } from "./reactor.js";
import { LineTransport } from "./stdio.js";

/** The socket file's mode when the caller does not say: the path is the access control. */
const DEFAULT_MODE = 0o600;

/** How long a connect waits before it gives up. */
const DEFAULT_TIMEOUT_MS = 5000;

/** What a listener knows about an accepted connection before an actor exists for it. */
export interface UnixSocketPeer {
  /** The path this side is bound to. */
  readonly path: string;
  /**
   * The peer's credentials, where the runtime gives them (Linux `SO_PEERCRED`).  Node exposes none on a
   * unix socket today, so this is undefined under node; the field is here for a runtime that can.
   */
  readonly peer?: { readonly uid: number; readonly gid: number; readonly pid?: number };
}

export interface UnixSocketListenerOptions<Meta = unknown> {
  /** The socket file.  Made when the listener starts, and removed when it stops. */
  path: string;
  /** The mode of the socket file, set before the first connection is taken.  Default 0o600. */
  mode?: number;
  /**
   * Whether a path that exists and refuses a connection may be replaced: a socket nobody listens on is a
   * crash's leftover.  A path that is not a socket at all is refused rather than removed.
   */
  replaceStale?: boolean;
  /** The listen backlog, passed through to the runtime. */
  backlog?: number;
  /**
   * Admission and identity.  What it returns is the connection's meta; throwing refuses the connection
   * before any actor exists.
   */
  identify?(peer: UnixSocketPeer): Meta | Promise<Meta>;
}

export interface UnixSocketClientOptions {
  /** How long to wait for the connection, in milliseconds.  Default 5000. */
  timeoutMs?: number;
}

/** What is at a path: nothing, a live listener, a socket nobody listens on, or something else. */
async function atPath(path: string): Promise<"free" | "listening" | "stale" | "other"> {
  try {
    const info = await stat(path);
    if (!info.isSocket()) return "other";
  } catch {
    return "free";
  }
  const answered = await new Promise<boolean>((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => {
      probe.destroy();
      resolve(false);
    });
  });
  return answered ? "listening" : "stale";
}

/**
 * Bind a path and answer connections from it, as the reactor's Listener: the socket file is made before
 * the first accept, its mode is set before the first connection is taken, and `close()` removes it if it
 * is still the inode this listener bound.
 */
export async function unixSocketListener<Meta = unknown>(
  options: UnixSocketListenerOptions<Meta>,
): Promise<Listener<Meta>> {
  const { path, mode = DEFAULT_MODE, replaceStale = true, backlog } = options;

  const there = await atPath(path);
  if (there === "listening") throw new Error(`unixSocketListener: something is listening at ${path}`);
  if (there === "other") throw new Error(`unixSocketListener: ${path} is not a socket`);
  if (there === "stale") {
    if (!replaceStale) throw new Error(`unixSocketListener: ${path} is a socket nobody listens on`);
    await unlink(path);
  }

  // Every connection this listener has taken or is holding: the close ends them, so a client learns the
  // listener is gone from its read end closing, and `server.close()` is not held open by a live socket.
  const connections = new Set<Socket>();
  const accepted: Socket[] = [];
  let waiting: { resolve: (socket: Socket) => void; reject: (error: Error) => void } | null = null;
  let closed = false;

  const server: Server = createServer();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    const taken = waiting;
    waiting = null;
    if (taken) taken.resolve(socket);
    else accepted.push(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path, backlog }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // The runtime makes the socket file with the process's umask; setting the mode here narrows the window
  // in which it is wider than asked for, since nothing has been accepted yet.
  await chmod(path, mode);
  const bound = await stat(path);

  const release = (error: Error): void => {
    const pending = waiting;
    waiting = null;
    pending?.reject(error);
  };

  return {
    accept(signal?: AbortSignal): Promise<Connection<Meta>> {
      if (closed) return Promise.reject(new Error(`unixSocketListener: ${path} is closed`));
      const taken = accepted.shift();
      const socket =
        taken ??
        new Promise<Socket>((resolve, reject) => {
          waiting = { resolve, reject };
          signal?.addEventListener(
            "abort",
            () => {
              if (waiting?.resolve === resolve) release(new Error(`unixSocketListener: ${path} was stopped`));
              reject(new Error(`unixSocketListener: ${path} was stopped`));
            },
            { once: true },
          );
        });
      return Promise.resolve(socket).then(async (connection) => {
        const peer: UnixSocketPeer = { path };
        const meta = options.identify ? await options.identify(peer) : (undefined as Meta);
        return { meta, transport: new LineTransport({ read: connection, write: connection }) };
      });
    },
    async close(): Promise<void> {
      closed = true;
      release(new Error(`unixSocketListener: ${path} is closed`));
      // Deleting from the set while iterating it is defined, and the deletion is the socket's own close
      // handler on a later turn, so the loop sees each of them once.
      for (const socket of connections) socket.destroy();
      connections.clear();
      accepted.length = 0;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const now = await stat(path);
        if (now.dev === bound.dev && now.ino === bound.ino) await unlink(path);
      } catch {
        // Already gone: nothing this listener made is left to remove.
      }
    },
  };
}

/** Connect to a listener: one call, and no open order, since a socket is connected or it is not. */
export async function connectUnixSocket(
  path: string,
  options: UnixSocketClientOptions = {},
): Promise<LineTransport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const attempt = connect(path);
    const timer = setTimeout(() => {
      attempt.destroy();
      reject(new Error(`connectUnixSocket: nothing answered at ${path} within ${timeoutMs}ms`));
    }, timeoutMs);
    attempt.once("connect", () => {
      clearTimeout(timer);
      resolve(attempt);
    });
    attempt.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(new Error(`connectUnixSocket: ${path}: ${error.message}`));
    });
  });
  return new LineTransport({ read: socket, write: socket });
}
