// ── posipaki/port/node ──────────────────────────────────────────────────────
//
// The ports that wrap this machine: a spawned command as a channel of bytes, and the two actor definitions built
// on it.  Everything here imports node:, so it is a separate entry — the portable one, `posipaki/port`, has no
// such import.

export { spawnPort, spawnPorts, type ProcessEnd, type ProcessPorts, type SpawnPortOptions } from "./node/spawn.js";
export { httpListener, type HttpListener, type HttpListenerOptions } from "./node/listener.js";
