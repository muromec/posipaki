// ── The kit a sandbox environment is handed ────────────────────────────────
//
// A real file on a throwaway path stands in for the consumer's build output: the
// bundle is read here and named inside the kit, and the script that writes it is
// the core's own.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bootstrapScript } from "posipaki/remote/node";
import { GATEWAY_ARTIFACT, PAYLOAD_ARTIFACT } from "./commands.js";
import { bwrapKit } from "./kit.js";
import type { KitSpec } from "./spec.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A bundle that says what it is, so a mistake in which file was read shows up. */
function bundle(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-bwrap-"));
  scratchDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function spec(payload: string, extra: Partial<KitSpec> = {}): KitSpec {
  return { app: { name: "email-agent", version: "0.13.0" }, payload, ...extra };
}

it("names the bundle inside the kit and hands the core the script that writes it", async () => {
  const kit = await bwrapKit(spec(bundle("payload.js", "// the payload\n")));
  expect(kit.files.map((file) => file.name)).toEqual([PAYLOAD_ARTIFACT, "version.json"]);
  expect(bootstrapScript(kit)).toContain('kit_dir="$HOME/bin/posipaki/');
});

it("carries the gateway too when the shape relays, and refuses one without it", async () => {
  const payload = bundle("payload.js", "// the payload\n");
  const gateway = bundle("gateway.js", "// the gateway\n");

  const relayed = await bwrapKit(spec(payload, { relay: true, gateway }));
  expect(relayed.files.map((file) => file.name)).toEqual([PAYLOAD_ARTIFACT, GATEWAY_ARTIFACT, "version.json"]);

  await expect(bwrapKit(spec(payload, { relay: true }))).rejects.toThrow(/gateway/);
});
