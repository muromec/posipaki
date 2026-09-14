// ── The kit a container is handed ──────────────────────────────────────────
//
// What travels: the consumer's build output, named inside the kit, with the core
// writing the script that puts it there.  Nothing here runs a container.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bootstrapScript } from "posipaki/remote/node";
import { PAYLOAD_ARTIFACT } from "./commands.js";
import { podmanKit } from "./kit.js";
import { PodmanSpecError } from "./spec.js";
import type { KitSpec } from "./spec.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A bundle on a throwaway path, so the kit has something real to read. */
function bundle(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "posipaki-podman-"));
  scratchDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function kit(payload: string, extra: Partial<KitSpec> = {}): KitSpec {
  return {
    app: { name: "email-agent", version: "0.13.0" },
    payload,
    ...extra,
  };
}

it("names the bundle inside the kit and hands the core the script that writes it", async () => {
  const built = await podmanKit(kit(bundle("payload.js", "// the payload\n")));
  expect(built.files.map((file) => file.name)).toEqual([PAYLOAD_ARTIFACT, "version.json"]);
  expect(built.app).toEqual({ name: "email-agent", version: "0.13.0" });
  expect(bootstrapScript(built)).toContain(`kit_dir="$HOME/bin/posipaki/${built.name}"`);
});

it("ships the gateway only when the shape relays, and refuses a relay without one", async () => {
  const payload = bundle("payload.js", "// the payload\n");
  const gateway = bundle("gateway.js", "// the gateway\n");

  const plain = await podmanKit(kit(payload));
  expect(plain.files.some((file) => file.name === "gateway.js")).toBe(false);

  const relayed = await podmanKit(kit(payload, { relay: true, gateway }));
  expect(relayed.files.some((file) => file.name === "gateway.js")).toBe(true);

  await expect(podmanKit(kit(payload, { relay: true }))).rejects.toThrow(PodmanSpecError);
});

it("takes the kit's parent and runtimes when the caller has opinions", async () => {
  const built = await podmanKit(
    kit(bundle("payload.js", "// the payload\n"), { parent: "opt/kits", runtime: ["bun"] }),
  );
  expect(built.parent).toBe("opt/kits");
  expect(built.runtimes).toEqual(["bun"]);
});
