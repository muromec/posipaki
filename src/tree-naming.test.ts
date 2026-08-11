/* eslint-disable unicorn/consistent-function-scoping */
// ── Actor Tree Naming Tests ─────────────────────────────────────────────
//
// Tests for automatic tree naming: defineActor({ name: 'x' }), optional
// name in fork, tree prefixing, and backward compat.

import { describe, it, expect } from "vitest";
import { defineActor } from "./define-actor.js";
import { AnyProcess, spawnAsync } from "./process.async.js";
import type { AsyncProcessFn, Message } from "./types.js";
import { ActorDefinition } from "./actor-types.js";

describe("defineActor name propagation", () => {
  it("exposes name on ActorDefinition", () => {
    const Actor = defineActor({
      name: "my-actor",
      setup: () => ({ count: 0 }),
      handlers: {},
    });

    expect(Actor.name).toBe("my-actor");
  });

  it("name is undefined when not set", () => {
    const Actor = defineActor({
      setup: () => ({ count: 0 }),
      handlers: {},
    });

    expect(Actor.name).toBeUndefined();
  });

  it("spawn uses config.name as default process name", async () => {
    const Actor = defineActor({
      name: "root-actor",
      setup: () => ({ count: 0 }),
      handlers: {},
    });

    const proc = await Actor.spawn({});
    expect(proc.pname).toBe("root-actor");
    proc.send({ type: "STOP" });
  });

  it('spawn falls back to "actor" when name not set', async () => {
    const Actor = defineActor({
      setup: () => ({ count: 0 }),
      handlers: {},
    });

    const proc = await Actor.spawn({});
    expect(proc.pname).toBe("actor");
    proc.send({ type: "STOP" });
  });
});

// ── tree prefixing ───────────────────────────────────────────────────────

describe("tree prefixing", () => {
  it("builds parent:child with explicit name via self.fork(name)", async () => {
    const Child = defineActor({
      name: "child",
      setup: () => ({ count: 0 }),
      handlers: {},
    });

    const Parent = defineActor({
      name: "parent",
      setup: () => ({ childPname: "" }),
      async afterStart() {
        const child = await this.fork(Child, "my-child", {});
        this.state.childPname = child.pname;
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    proc.send({ type: "STOP" });
    await proc.wait();
    expect(proc.state!.childPname).toBe("parent:my-child");
  });

  it("derives child name from definition when name omitted in self.fork", async () => {
    const Child = defineActor({
      name: "child",
      handlers: {},
    });

    const Parent = defineActor({
      name: "parent",
      setup: () => ({ childPname: "" }),
      async afterStart() {
        // No name — should pick up 'child' from the definition
        const child = await this.fork(Child, undefined, {});
        this.state.childPname = child.pname;
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    proc.send!({ type: "STOP" });
    await proc.wait();
    expect(proc.state!.childPname).toBe("parent:child");
  });

  it("raw generator with ctx.fork uses exact name (no prefix)", async () => {
    const rawFn: AsyncProcessFn<null, { x: number }, never, never> =
      async function* () {
        yield { x: 1 };
      };

    const root = spawnAsync(rawFn, "root")(null);
    expect(root.pname).toBe("root");

    // Low-level fork uses exact name — no tree prefix.
    const child = root.fork(rawFn, "worker")(null);
    expect(child.pname).toBe("worker");

    child.send({ type: "STOP" });
    root.send({ type: "STOP" });
    await root.wait();
  });

  it("three-level tree a:b:c", async () => {
    const Grandchild = defineActor({
      name: "grandchild",
      handlers: {},
    });

    const Child = defineActor({
      name: "child",
      async setup() {
        // self.fork with name from definition
        const gc = await this.fork(Grandchild, undefined, {});
        return { gc };
      },
      handlers: {},
    });

    const Parent = defineActor({
      name: "parent",
      async setup() {
        const child = await this.fork(Child, undefined, {});
        return { child };
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.ready();

    const childProc = proc.state!.child;
    expect(childProc).not.toBeNull();
    expect(childProc.pname).toBe("parent:child");

    await childProc.ready();
    const grandchildProc = childProc.state!.gc;
    expect(grandchildProc).not.toBeNull();
    expect(grandchildProc.pname).toBe("parent:child:grandchild");

    proc.send!({ type: "STOP" });
    await proc.wait();
  });

  it("explicit override with self.fork(name)", async () => {
    const Child = defineActor({
      name: "child",
      handlers: {},
    });

    const Parent = defineActor({
      name: "parent",
      setup: () => ({ childPname: "" }),
      async afterStart() {
        const child = await this.fork(Child, "override", {});
        this.state.childPname = child.pname;
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    proc.send!({ type: "STOP" });
    await proc.wait();
    expect(proc.state!.childPname).toBe("parent:override");
  });
});

// ── adversarial ──────────────────────────────────────────────────────────

describe("tree naming — adversarial", () => {
  it("two children with same definition get the same name", async () => {
    const Worker = defineActor({
      name: "worker",
      setup: () => ({ count: 0 }),
      handlers: {},
    });

    const Parent = defineActor({
      name: "parent",
      setup: () => ({ w1: "", w2: "" }),
      async afterStart() {
        const c1 = await this.fork(Worker, undefined, {});
        const c2 = await this.fork(Worker, undefined, {});
        this.state.w1 = c1.pname;
        this.state.w2 = c2.pname;
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    proc.send({ type: "STOP" });
    await proc.wait();
    expect(proc.state!.w1).toBe("parent:worker");
    expect(proc.state!.w2).toBe("parent:worker");
  });

  it("deeply nested tree does not crash", async () => {
    const collector: string[] = [];
    const Leaf = defineActor({
      name: "leaf",
      async setup({ level }: { level: number }) {
        collector.push(this.name);
        let nextLevel = level + 1;
        if (nextLevel > 10) {
          return;
        }
        const child = await this.fork(leaf1, `leaf-${nextLevel}`, {
          level: nextLevel,
        });
        return { child };
      },
      handlers: {},
    });
    const leaf1 = Leaf as ActorDefinition<
      { level: number },
      unknown,
      Message,
      Message,
      {}
    >;

    const proc = await Leaf.spawn({ level: 0 });
    expect(collector).toEqual(["leaf", "leaf:leaf-1"]);
    await proc.ready();

    proc.send!({ type: "STOP" });
    await proc.wait();
    expect(collector).toEqual([
      "leaf",
      "leaf:leaf-1",
      "leaf:leaf-1:leaf-2",
      "leaf:leaf-1:leaf-2:leaf-3",
      "leaf:leaf-1:leaf-2:leaf-3:leaf-4",
      "leaf:leaf-1:leaf-2:leaf-3:leaf-4:leaf-5",
      "leaf:leaf-1:leaf-2:leaf-3:leaf-4:leaf-5:leaf-6",
      "leaf:leaf-1:leaf-2:leaf-3:leaf-4:leaf-5:leaf-6:leaf-7",
      "leaf:leaf-1:leaf-2:leaf-3:leaf-4:leaf-5:leaf-6:leaf-7:leaf-8",
      "leaf:leaf-1:leaf-2:leaf-3:leaf-4:leaf-5:leaf-6:leaf-7:leaf-8:leaf-9",
      "leaf:leaf-1:leaf-2:leaf-3:leaf-4:leaf-5:leaf-6:leaf-7:leaf-8:leaf-9:leaf-10",
    ]);
  });

  it("EXIT from child is recognized under tree-prefixed name", async () => {
    const Child = defineActor({
      name: "child",
      setup: () => ({ count: 0 }),
      handlers: {},
      onStopRequested() {
        this.agreeToStop();
      },
    });

    const Parent = defineActor({
      name: "parent",
      setup: () => ({ exitCount: 0, exitedName: "" }),
      async afterStart() {
        await this.fork(Child, undefined, {});
      },
      onStopRequested() {
        this.$child["parent:child"].send({ type: "STOP" });
      },
      onChildExit(name: string) {
        this.state.exitCount++;
        this.state.exitedName = name;
        this.exit("done");
      },
      handlers: {},
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    proc.send!({ type: "STOP" });
    await proc.wait();
    expect(proc.state!.exitCount).toEqual(1);
    expect(proc.state!.exitedName).toEqual("parent:child");
  });
});
