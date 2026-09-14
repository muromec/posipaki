// ── Putting the actor in the container ─────────────────────────────────────
//
// The preparing channel: the bootstrap script goes in on stdin, and one report
// line per step comes back.  Nothing of the payload runs yet — that is the run
// channel — so a failure here is a readable reason instead of a dead channel.
//
// This is what a prepare step is for the bootstrap shape, and it is the only prepare
// this package ships: an actor already in the image needs none.

import { bootstrapScript, parseBootstrapReport } from "posipaki/remote/node";
import { podmanStageCommand } from "./commands.js";
import { runHost } from "./host.js";
import type { HostResult, HostRun } from "./host.js";
import { podmanKit } from "./kit.js";
import { PodmanSpecError } from "./spec.js";
import type { KitSpec, PodmanStaged } from "./spec.js";

/** How much of what a failed command said we quote back. */
const SAID_TAIL = 400;

/** The tail of what a command said, for a failure that has no better story. */
function said(result: HostResult): string {
  const text = `${result.stderr}${result.stdout}`.trim();
  const tail = text.length > SAID_TAIL ? text.slice(-SAID_TAIL) : text;
  return tail === "" ? `exit code ${result.code}` : tail;
}

/**
 * Put the kit in the container and say what will run it.  Idempotent on the far
 * side: it probes, writes only what is missing, and reports — so preparing an
 * actor that is already there costs one exec and no writes.
 */
export async function podmanStage(
  container: string,
  kit: KitSpec,
  run: HostRun = runHost,
): Promise<PodmanStaged> {
  // The kit is read first: a spec that cannot be staged should fail before a
  // command is run on its behalf.
  const built = await podmanKit(kit);
  const result = await run(podmanStageCommand(container), bootstrapScript(built));
  const report = parseBootstrapReport(result.stdout);
  if (report.kind === "error") {
    // A report that never arrived is not a reason; what the container said is.
    const incomplete =
      report.reason.startsWith("incomplete") || report.reason.startsWith("no report");
    throw new PodmanSpecError(
      `staging into container ${container} failed: ${report.reason}${
        incomplete ? ` (${said(result)})` : ""
      }`,
    );
  }
  return { kitDir: report.kitDir, runtime: report.runtime };
}
