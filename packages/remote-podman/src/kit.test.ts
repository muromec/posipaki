// ── The kit a container environment is handed ──────────────────────────────
//
// A real file on a throwaway path stands in for the consumer's build output: the
// bundle is read here and named inside the kit, and the script that writes it in
// the container is the core's own.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LIB_VERSION } from "posipaki";
import { bootstrapScript } from "posipaki/remote/node";
import { GATEWAY_ARTIFACT, PAYLOAD_ARTIFACT } from "./commands.js";
import { podmanKit } from "./kit.js";
import type { PodmanSpec } from "./spec.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A bundle on a throwaway path, so a mistake in which file was read shows up. */
function bundle(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-podman-"));
  scratchDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function spec(payload: string, extra: Partial<PodmanSpec> = {}): PodmanSpec {
  return {
    image: "toolbox:1",
    container: "env-agent",
    app: { name: "email-agent", version: "0.13.0" },
    payload,
    ...extra,
  };
}

it("names the bundle inside the kit and hands the core the script that writes it", async () => {
  const kit = await podmanKit(spec(bundle("payload.js", "// the payload\n")));
  expect(kit.files.map((file) => file.name)).toEqual([PAYLOAD_ARTIFACT, "version.json"]);
  expect(kit.app).toEqual({ name: "email-agent", version: "0.13.0" });
  expect(bootstrapScript(kit)).toContain(`kit_dir="$HOME/bin/posipaki/${kit.name}"`);
});

it("carries the gateway when the shape relays, and insists on having one", async () => {
  const payload = bundle("payload.js", "// the payload\n");
  const gateway = bundle("gateway.js", "// the gateway\n");
  const kit = await podmanKit(spec(payload, { relay: true, gateway }));
  expect(kit.files.map((file) => file.name)).toEqual([
    PAYLOAD_ARTIFACT,
    GATEWAY_ARTIFACT,
    "version.json",
  ]);
  await expect(podmanKit(spec(payload, { relay: true }))).rejects.toThrow(/gateway/);
});

it("takes the runtime candidates and the kit's parent from the spec", async () => {
  const kit = await podmanKit(
    spec(bundle("payload.js", "// the payload\n"), { runtime: ["bun"], parent: "opt/kits" }),
  );
  expect(kit.runtimes).toEqual(["bun"]);
  expect(kit.parent).toBe("opt/kits");
});

it("names the kit after its contents and its owner, so two builds cannot collide", async () => {
  const one = await podmanKit(spec(bundle("payload.js", "// one\n")));
  const two = await podmanKit(spec(bundle("payload.js", "// two\n")));
  expect(one.name).toBe(
    `email-agent-0.13.0-posipaki-${LIB_VERSION}-${one.manifestHash.slice(0, 8)}`,
  );
  expect(one.name).not.toBe(two.name);
});
