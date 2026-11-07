// ── posipaki/port/node ──────────────────────────────────────────────────────
//
// The port that wraps this machine: a spawned command as a channel of bytes.  Everything here imports node:,
// so it is a separate entry — the portable one, `posipaki/port`, has no such import.

export { spawnPort, spawnPorts, type ProcessExit, type ProcessPorts, type SpawnPortOptions } from "./node/spawn.js";
