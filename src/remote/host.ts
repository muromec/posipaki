// ── Running one command on the host ────────────────────────────────────────
//
// Everything a way in does, it does by running a command: staging is a command in an
// environment, and the actor is another one whose stdin/stdout are the wire.  Both go
// through the two functions here, and both are handed in — so a test can stage and run
// without a sandbox, a host or a container, and a consumer can run host commands its
// own way.

import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";

export interface HostResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command, feed it its stdin, and wait for what it said. */
export type HostRun = (command: string[], stdin: string) => Promise<HostResult>;

/** The real thing: spawn it, feed it, collect it. */
export const runHost: HostRun = (command, stdin) =>
  new Promise((settle, fail) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => out.push(chunk));
    child.stderr.on("data", (chunk: string) => err.push(chunk));
    child.once("error", (error) => fail(error));
    // A host that hangs up while we are still writing has failed; the exit code and
    // stderr carry that, so the write error is not the story here.
    child.stdin.on("error", () => {});
    child.once("close", (code) => settle({ code, stdout: out.join(""), stderr: err.join("") }));
    child.stdin.end(stdin);
  });

/** How the wire's process is started, with the stdio it needs. */
export type SpawnChild = (command: string[], stdio: StdioOptions) => ChildProcess;

/** The real thing: node's own spawn, in our working directory. */
export const spawnChild: SpawnChild = (command, stdio) =>
  spawn(command[0]!, command.slice(1), { cwd: process.cwd(), stdio });
