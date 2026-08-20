// ── inspect Plugin Tests ─────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { defineActor, defineMessages } from "../define-actor.js";
import type { Message } from "../types.js";
import { inspect, type TreeNode } from "./tree-introspection.js";

// ── messages ─────────────────────────────────────────────────────────────

interface PokeMsg extends Message {
  type: "POKE";
}
const Pin = defineMessages<PokeMsg>();

// ── helpers ──────────────────────────────────────────────────────────────

describe("inspect", () => {
  describe("getTree", () => {
    it("returns pname, parentName, children, status", async () => {
      const Actor = defineActor({
        name: "test-actor",
        plugins: [inspect()],
        handlers: {},
      });

      const proc = await Actor.spawn({});
      await proc.ready();

      const tree = proc.$reflection["inspect.getTree"]();
      expect(tree.pname).toBe("test-actor");
      expect(tree.parentName).toBeNull();
      expect(tree.children).toEqual([]);
      expect(tree.status).toBe("running");

      proc.send!({ type: "STOP" }, { fromName: "t", fromId: Symbol("t") });
      await proc.wait();
    });

    it("returns recursive child trees", async () => {
      const Leaf = defineActor({
        name: "leaf",
        plugins: [inspect()],
        handlers: {},
      });
      const Parent = defineActor({
        name: "parent",
        plugins: [inspect()],
        async setup(this: any) {
          await this.fork(Leaf, undefined, { name: "kid" });
          return {};
        },
        handlers: {},
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      const tree = proc.$reflection["inspect.getTree"]();
      expect(tree.children.length).toBeGreaterThanOrEqual(1);
      const child = tree.children.find((c: TreeNode) =>
        c.pname.includes("kid"),
      );
      expect(child).toBeDefined();
      expect(child!.status).toBe("running");
      expect(child!.parentName).toBe("parent");

      proc.send({ type: "STOP" });
      await proc.wait();
    });

    it('marks children without inspect as "no introspection"', async () => {
      const Plain = defineActor({
        name: "plain",
        plugins: [], // block inheritance
        handlers: {},
      });
      const Parent = defineActor({
        name: "root",
        plugins: [inspect()],
        async setup(this: any) {
          await this.fork(Plain, undefined, { name: "plain-child" });
          return {};
        },
        handlers: {},
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      const tree = proc.$reflection["inspect.getTree"]();
      expect(tree.children.length).toBeGreaterThanOrEqual(1);
      const child = tree.children[0];
      expect(child.status).toBe("no introspection");
      expect(child.children).toEqual([]);

      proc.send({ type: "STOP" });
      await proc.wait();
    });

    it("prefix filters nodes by pname", async () => {
      const Child = defineActor({
        name: "worker",
        plugins: [inspect()],
        handlers: {},
      });
      const Parent = defineActor({
        name: "main",
        plugins: [inspect()],
        async setup() {
          await this.fork(Child);
          await this.fork(Child, undefined, { name: "w2" });
          return {};
        },
        handlers: {},
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      // No prefix — full tree
      const full = proc.$reflection["inspect.getTree"]();
      expect(full.pname).toBe("main");
      expect(full.children.length).toEqual(2);
      expect(full.children[0].pname).toBe("main:worker");
      expect(full.children[1].pname).toBe("main:w2");

      // Prefix that matches child
      const filtered = proc.$reflection["inspect.getTree"]("main:worker");
      expect(filtered.pname).toBe("main");
      expect(filtered.children.length).toBe(1);
      expect(filtered.children[0].pname).toBe("main:worker");
      proc.send({ type: "STOP" });
      await proc.wait();
    });

    it("does not clobber across spawns", async () => {
      const Actor = defineActor({
        name: "clobber-test",
        setup: () => ({ label: "default" }),
        plugins: [inspect()],
        handlers: {},
      });

      const proc1 = await Actor.spawn({});
      const proc2 = await Actor.spawn({});
      await proc1.ready();
      await proc2.ready();

      const t1 = proc1.$reflection["inspect.getTree"]();
      const t2 = proc2.$reflection["inspect.getTree"]();
      expect(t1.pname).toBe("clobber-test");
      expect(t2.pname).toBe("clobber-test");

      proc1.send({ type: "STOP" });
      proc2.send({ type: "STOP" });
      await proc1.wait();
      await proc2.wait();
    });
  });

  describe("getState", () => {
    it("returns raw state", async () => {
      const Actor = defineActor({
        name: "state-test",
        inMessages: Pin,
        setup: () => ({ count: 0 }),
        plugins: [inspect()],
        handlers: {
          POKE() {
            this.state.count++;
          },
        },
      });

      const proc = await Actor.spawn({});
      await proc.ready();
      proc.send({ type: "POKE" });
      await new Promise((r) => setTimeout(r, 0));

      const state = proc.$reflection["inspect.getState"]();
      expect(state).toEqual({ count: 1 });

      proc.send({ type: "STOP" });
      await proc.wait();
    });
  });

  describe("exit", () => {
    it("causes the actor to exit from inside", async () => {
      const Actor = defineActor({
        name: "exit-test",
        plugins: [inspect()],
        handlers: {},
      });

      const proc = await Actor.spawn({});
      await proc.ready();

      proc.$reflection["inspect.exit"]();
      await proc.wait();
    });
  });

  describe("find", () => {
    it("returns a descendant process by full pname", async () => {
      const Child = defineActor({
        name: "leaf",
        plugins: [inspect()],
        handlers: {},
      });
      const Parent = defineActor({
        name: "parent",
        plugins: [inspect()],
        async setup(this: any) {
          await this.fork(Child, undefined, { name: "kid" });
          return {};
        },
        handlers: {},
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      const found = proc.$reflection["inspect.find"]("parent:kid");
      expect(found).not.toBeNull();
      expect(found!.pname).toBe("parent:kid");

      proc.send({ type: "STOP" });
      await proc.wait();
    });

    it("reaches children without the inspect plugin", async () => {
      const Plain = defineActor({
        name: "plain",
        plugins: [], // block inheritance
        handlers: {},
      });
      const Parent = defineActor({
        name: "root",
        plugins: [inspect()],
        async setup(this: any) {
          await this.fork(Plain, undefined, { name: "plain-child" });
          return {};
        },
        handlers: {},
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      const found = proc.$reflection["inspect.find"]("root:plain-child");
      expect(found).not.toBeNull();
      expect(found!.pname).toBe("root:plain-child");

      proc.send({ type: "STOP" });
      await proc.wait();
    });

    it("returns null for an unknown pname", async () => {
      const Actor = defineActor({
        name: "solo",
        plugins: [inspect()],
        handlers: {},
      });

      const proc = await Actor.spawn({});
      await proc.ready();

      expect(proc.$reflection["inspect.find"]("nope")).toBeNull();

      proc.send({ type: "STOP" });
      await proc.wait();
    });
  });
});
