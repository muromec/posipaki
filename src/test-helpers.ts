// ── Shared test types ────────────────────────────────────────────────────────
//
// Common message shapes used across multiple test files.  Import what you
// need instead of redefining PingM/PongM/PokeM in every test.

/** A simple ping message with a sequence number. */
export type PingM = { type: "PING"; pseq: number };

/** A simple pong response with a sequence number. */
export type PongM = { type: "PONG"; pseq: number };

/** A minimal poke message — no payload. */
export type PokeM = { type: "POKE" };

/** A basic counter state. */
export type CountStore = { count: number };
