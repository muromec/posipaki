// ── Staging the kit in the container ───────────────────────────────────────
//
// The first channel: the container is there (or we start it and wait for it), the
// bootstrap script goes in on stdin, and one report line per step comes back.
// Nothing of the payload runs yet — that is the second channel — so a failure here
// is a readable reason instead of a dead channel.

import { bootstrapScript, parseBootstrapReport } from "posipaki/remote/node";
import { podmanStageCommand } from "./commands.js";
import { runHost } from "./host.js";
import type { HostResult } from "./host.js";
import { podmanKit } from "./kit.js";
import { ensureContainer } from "./lifetime.js";
import type { PodmanLifetimeOptions } from "./lifetime.js";
import { containerName, PodmanSpecError } from "./spec.js";
import type { PodmanSpec, PodmanStaged } from "./spec.js";

/** How much of what a failed command said we quote back. */
const SAID_TAIL = 400;

/** The tail of what a command said, for a failure that has no better story. */
function said(result: HostResult): string {
  const text = `${result.stderr}${result.stdout}`.trim();
  const tail = text.length > SAID_TAIL ? text.slice(-SAID_TAIL) : text;
  return tail === "" ? `exit code ${result.code}` : tail;
}

/**
 * Put the kit in the container and say what will run it.  The container comes
 * first, because there is nothing to stage into without it; staging itself is
 * idempotent on the far side — it probes, writes only what is missing, reports.
 */
export async function podmanStage(
  spec: PodmanSpec,
  options: PodmanLifetimeOptions = {},
): Promise<PodmanStaged> {
  // The kit is read first: a spec that cannot be staged should fail before a
  // container is started on its behalf.
  const kit = await podmanKit(spec);
  await ensureContainer(spec, options);
  const result = await (options.runHost ?? runHost)(podmanStageCommand(spec), bootstrapScript(kit));
  const report = parseBootstrapReport(result.stdout);
  if (report.kind === "error") {
    // A report that never arrived is not a reason; what the container said is.
    const incomplete =
      report.reason.startsWith("incomplete") || report.reason.startsWith("no report");
    throw new PodmanSpecError(
      `staging into container ${containerName(spec)} failed: ${report.reason}${
        incomplete ? ` (${said(result)})` : ""
      }`,
    );
  }
  return { kitDir: report.kitDir, runtime: report.runtime };
}
