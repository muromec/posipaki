// ── reflection across a real process boundary ──────────────────────────────
//
// The whole seam, end to end: a payload in a process of its own, driven through
// json1 over a fifo pair.  What the unit tests cannot check is here — that the
// announcement survives the encoder, and that the tree a harness walks does not
// stop at the boundary.

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { remoteClient } from "./client.js";
import { commandSpawner } from "./spawners/fifo-command.js";
import type { TreeNode } from "../plugins/tree-introspection.js";
import type { Message } from "../types.js";

type Surface = Record<string, (...args: unknown[]) => Promise<unknown>>;

const fixture = join(dirname(import.meta.url.slice(7)), "./fixtures/reflect-payload.js");

async function spawnPayload() {
  const actor = remoteClient<Record<string, unknown>, Record<string, unknown>, Message, Message>(
    "reflector",
    commandSpawner([process.argv[0], fixture]),
  );
  const proc = await actor.spawn({});
  return { proc, surface: proc.$reflection as unknown as Surface };
}

describe("reflection across a process boundary", () => {
  it("answers a call with the far side's own method", async () => {
    const { proc, surface } = await spawnPayload();

    expect(await surface["probe.add"](40, 2)).toBe(42);

    await proc.stop();
  }, 20000);

  it("keeps two calls to the same method apart", async () => {
    const { proc, surface } = await spawnPayload();

    const [slow, quick] = await Promise.all([surface["probe.late"](30), surface["probe.late"](0)]);
    expect([slow, quick]).toEqual(["late:30", "late:0"]);

    await proc.stop();
  }, 20000);

  it("carries a refusal back as the reason", async () => {
    const { proc, surface } = await spawnPayload();

    await expect(surface["probe.boom"]()).rejects.toThrow("probe said no");
    await expect(surface["probe.refusing"]()).rejects.toThrow(/cannot cross a frame/);
    expect(surface["probe.nope"]).toBeUndefined();

    await proc.stop();
  }, 20000);

  it("walks into the far side's tree instead of stopping at the boundary", async () => {
    const { proc, surface } = await spawnPayload();

    const tree = (await surface["inspect.getTree"]()) as TreeNode;
    expect(tree.status).toBe("running");
    expect(tree.children.map((child) => child.pname)).toEqual(["remote:kid"]);
    expect(tree.children[0].status).toBe("no introspection");

    await proc.stop();
  }, 20000);
});
