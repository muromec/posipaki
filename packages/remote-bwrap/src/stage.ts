// ── Putting the actor in the sandbox ───────────────────────────────────────
//
// The preparing channel: the bootstrap script goes in on stdin, and one report
// line per step comes back.  Nothing of the payload runs yet — that is the run
// channel — so a failure here is a readable reason instead of a dead channel.
//
// This is what a prepare step is for the bootstrap shape, and the only prepare
// this package ships: an actor already on the machine needs none.

import { bootstrapScript, parseBootstrapReport } from "posipaki/remote/node";
import { bwrapStageCommand } from "./commands.js";
import { runHost } from "./host.js";
import type { HostResult, HostRun } from "./host.js";
import { bwrapKit } from "./kit.js";
import { BwrapSpecError } from "./spec.js";
import type { BwrapStaged, SandboxSpec, KitSpec } from "./spec.js";

/** How much of what a failed command said we quote back. */
const SAID_TAIL = 400;

/** The tail of what a command said, for a failure that has no better story. */
function said(result: HostResult): string {
  const text = `${result.stderr}${result.stdout}`.trim();
  const tail = text.length > SAID_TAIL ? text.slice(-SAID_TAIL) : text;
  return tail === "" ? `exit code ${result.code}` : tail;
}

/**
 * Put the kit where the sandbox can see it and say what will run it.  Idempotent:
 * the script probes, writes only what is missing, and reports — so preparing an
 * actor that is already there costs one process and no writes.
 */
export async function bwrapStage(
  sandbox: SandboxSpec,
  kit: KitSpec,
  run: HostRun = runHost,
): Promise<BwrapStaged> {
  // The kit is read first: a spec that cannot be staged should fail before a
  // command is run on its behalf.
  const built = await bwrapKit(kit);
  const result = await run(bwrapStageCommand(sandbox), bootstrapScript(built));
  const report = parseBootstrapReport(result.stdout);
  if (report.kind === "error") {
    // A report that never arrived is not a reason; what the sandbox said is.
    const incomplete =
      report.reason.startsWith("incomplete") || report.reason.startsWith("no report");
    throw new BwrapSpecError(
      `staging into sandbox ${sandbox.name} failed: ${report.reason}${
        incomplete ? ` (${said(result)})` : ""
      }`,
    );
  }
  return { kitDir: report.kitDir, runtime: report.runtime };
}
