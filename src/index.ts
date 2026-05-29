/**
 * Posipaki — Erlang-inspired lightweight actor processes built on
 * generator functions. Processes communicate via message-passing,
 * can fork children, and expose their state reactively.
 *
 * ## Quick start
 *
 * ```ts
 * import { spawn, runDispatch } from 'posipaki'
 *
 * function* hello({ pname }) {
 *   const state = { count: 0 }
 *   yield state
 *   yield* runDispatch(pname, (msg) => {
 *     if (msg.type === 'POKE') state.count++
 *   }, () => false)
 * }
 *
 * const proc = spawn(hello, 'hello')(null)
 * proc.send({ type: 'POKE' })
 * proc.tick()
 * console.log(proc.state.count) // 1
 * ```
 *
 * @module
 */

import { Process, spawn } from "./process";
import type { Message, ProcessCtx, ProcessFn } from "./process";
import { runDispatch } from "./util";
import type { ExitMessage } from "./util";

export { Process, spawn, runDispatch };
export type { Message, ExitMessage, ProcessCtx, ProcessFn };
