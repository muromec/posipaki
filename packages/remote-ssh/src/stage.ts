// ── Staging the kit on the host ────────────────────────────────────────────
//
// The first channel: the bootstrap script goes in on stdin, and one report line
// per step comes back.  Nothing of the payload runs yet — that is the second
// channel — so a failure here is a readable reason instead of a dead channel.

import { bootstrapScript, parseBootstrapReport } from "posipaki/remote/node";
import { sshStageCommand } from "./commands.js";
import { runHost } from "./host.js";
import type { HostResult, HostRun } from "./host.js";
import { sshKit } from "./kit.js";
import { SshSpecError } from "./spec.js";
import type { SshSpec, SshStaged } from "./spec.js";

/** How much of what a failed command said we quote back. */
const SAID_TAIL = 400;

/** The tail of what a command said, for a failure that has no better story. */
function said(result: HostResult): string {
  const text = `${result.stderr}${result.stdout}`.trim();
  const tail = text.length > SAID_TAIL ? text.slice(-SAID_TAIL) : text;
  return tail === "" ? `exit code ${result.code}` : tail;
}

/**
 * Put the kit on the host and say what will run it.  Staging is idempotent on
 * the host's side — it probes, writes only what is missing, and reports — so a
 * spawn may stage again without disturbing a kit that is already there.
 */
export async function sshStage(
  spec: SshSpec,
  options: { runHost?: HostRun } = {},
): Promise<SshStaged> {
  const kit = await sshKit(spec);
  const result = await (options.runHost ?? runHost)(sshStageCommand(spec), bootstrapScript(kit));
  const report = parseBootstrapReport(result.stdout);
  if (report.kind === "error") {
    // A report that never arrived is not a reason; what the host said is.
    const incomplete =
      report.reason.startsWith("incomplete") || report.reason.startsWith("no report");
    throw new SshSpecError(
      `staging into ssh ${spec.host} failed: ${report.reason}${incomplete ? ` (${said(result)})` : ""}`,
    );
  }
  return { kitDir: report.kitDir, runtime: report.runtime };
}
