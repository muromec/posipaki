/**
 * Posipaki — Erlang-inspired lightweight actor processes built on
 * generator functions. Processes communicate via message-passing,
 * can fork children, and expose their state reactively.
 *
 * @module
 */

import { Process, spawn } from "./process"
import type { Message, ProcessCtx, ProcessFn } from "./process"
import { runDispatch } from "./util"
import type { ExitMessage } from "./util"
import { AsyncProcess, spawnAsync, runDispatchAsync, asyncify } from "./process.async"
import type { AsyncProcessFn } from "./process.async"

export { Process, spawn, runDispatch }
export { AsyncProcess, spawnAsync, runDispatchAsync, asyncify }
export type { Message, ExitMessage, ProcessCtx, ProcessFn, AsyncProcessFn }
