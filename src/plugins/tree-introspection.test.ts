// ── inspect Plugin Tests ─────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { defineActor, defineMessages } from "../define-actor.js";
import type { Message } from "../types.js";
import { inspect, type FoundProcess, type TreeNode } from "./tree-introspection.js";
import type { AnyProcess } from "../process.async.js";
import { nextState } from "../testing/tick-utils.js";

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

      const tree = await proc.$reflection["inspect.getTree"]();
      expect(tree.pname).toBe("test-actor");
      expect(tree.parentName).toBeNull();
      expect(tree.children).toEqual([]);
      expect(tree.status).toBe("running");

      await proc.stop();
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

      const tree = await proc.$reflection["inspect.getTree"]();
      expect(tree.children.length).toBeGreaterThanOrEqual(1);
      const child = tree.children.find((c: TreeNode) => c.pname.includes("kid"));
      expect(child).toBeDefined();
      expect(child!.status).toBe("running");
      expect(child!.parentName).toBe("parent");

      await proc.stop();
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

      const tree = await proc.$reflection["inspect.getTree"]();
      expect(tree.children.length).toBeGreaterThanOrEqual(1);
      const child = tree.children[0];
      expect(child.status).toBe("no introspection");
      expect(child.children).toEqual([]);

      await proc.stop();
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
      const full = await proc.$reflection["inspect.getTree"]();
      expect(full.pname).toBe("main");
      expect(full.children.length).toEqual(2);
      expect(full.children[0].pname).toBe("main:worker");
      expect(full.children[1].pname).toBe("main:w2");

      // Prefix that matches child
      const filtered = await proc.$reflection["inspect.getTree"]("main:worker");
      expect(filtered.pname).toBe("main");
      expect(filtered.children.length).toBe(1);
      expect(filtered.children[0].pname).toBe("main:worker");
      await proc.stop();
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

      const [t1, t2] = await Promise.all([
        proc1.$reflection["inspect.getTree"](),
        proc2.$reflection["inspect.getTree"](),
      ]);
      expect(t1.pname).toBe("clobber-test");
      expect(t2.pname).toBe("clobber-test");

      await proc1.stop();
      await proc2.stop();
    });
  });

  describe("getState", () => {
    it("returns raw internal state", async () => {
      const Actor = defineActor({
        name: "state-test",
        inMessages: Pin,
        setup: () => ({ public: null, private: { count: 0 } }),
        plugins: [inspect()],
        handlers: {
          POKE() {
            this.state.private.count++;
          },
        },
      });

      const proc = await Actor.spawn({});
      await proc.ready();
      proc.send({ type: "POKE" });
      expect(await nextState(proc)).toBe(null);

      const state = await proc.$reflection["inspect.getState"]();
      expect(state).toEqual({ private: { count: 1 }, public: null });

      await proc.stop();
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
    /** What a proxy child answers with: a name, what it holds, what it can answer. */
    const farProcess = (pname: string, letGoOf: string[] = []) => ({
      pname,
      state: null,
      $reflection: {},
      stop: async () => undefined,
      release: () => void letGoOf.push(pname),
    });

    /** Make a child answer a search as a proxy does, and say what it was asked. */
    function announceFind(proc: AnyProcess, answer: (pname: string) => unknown, asked: string[]) {
      const surface = proc.$reflection as unknown as Record<string, unknown>;
      surface["inspect.find"] = async (pname: string) => {
        asked.push(pname);
        return answer(pname);
      };
    }

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

      const found = await proc.$reflection["inspect.find"]("parent:kid");
      expect(found).not.toBeNull();
      expect(found!.pname).toBe("parent:kid");
      // A name that is here is found here, so what comes back is this side's own process.
      expect((found as AnyProcess).id).toBe(proc.children[0].id);

      await proc.stop();
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

      const found = await proc.$reflection["inspect.find"]("root:plain-child");
      expect(found).not.toBeNull();
      expect(found!.pname).toBe("root:plain-child");

      await proc.stop();
    });

    it("returns null for an unknown pname", async () => {
      const Actor = defineActor({
        name: "solo",
        plugins: [inspect()],
        handlers: {},
      });

      const proc = await Actor.spawn({});
      await proc.ready();

      expect(await proc.$reflection["inspect.find"]("nope")).toBeNull();

      await proc.stop();
    });

    it("asks a child whose name the target sits under, and answers with what it said", async () => {
      const Proxy = defineActor({
        name: "proxy",
        plugins: [], // nothing of this side's own is announced here
        handlers: {},
      });
      const Parent = defineActor({
        name: "parent",
        plugins: [inspect()],
        async setup(this: any) {
          await this.fork(Proxy);
          return {};
        },
        handlers: {},
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      const far = farProcess("parent:proxy:kid");
      const asked: string[] = [];
      announceFind(proc.children[0], (pname) => (pname === "parent:proxy:kid" ? far : null), asked);

      const found = await proc.$reflection["inspect.find"]("parent:proxy:kid");
      expect(found).toBe(far);
      expect(asked).toEqual(["parent:proxy:kid"]);

      await proc.stop();
    });

    it("skips a child that announced nothing, and answers null", async () => {
      const Plain = defineActor({ name: "plain", plugins: [], handlers: {} });
      const Parent = defineActor({
        name: "parent",
        plugins: [inspect()],
        async setup(this: any) {
          await this.fork(Plain);
          return {};
        },
        handlers: {},
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      expect(await proc.$reflection["inspect.find"]("parent:plain:kid")).toBeNull();

      await proc.stop();
    });

    it("asks every child, hands the first answer back, and lets go of the rest", async () => {
      const First = defineActor({ name: "first", plugins: [], handlers: {} });
      const Second = defineActor({ name: "second", plugins: [], handlers: {} });
      const Parent = defineActor({
        name: "parent",
        plugins: [inspect()],
        async setup(this: any) {
          await this.fork(First);
          await this.fork(Second);
          return {};
        },
        handlers: {},
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      const letGoOf: string[] = [];
      const firstAnswer = farProcess("parent:first:kid");
      const secondAnswer = farProcess("parent:second:kid", letGoOf);
      const firstAsked: string[] = [];
      const secondAsked: string[] = [];
      const [first, second] = proc.children;
      announceFind(first, () => firstAnswer, firstAsked);
      announceFind(second, () => secondAnswer, secondAsked);

      // Both are asked, as the walk asks both: a child's subtree is its own to answer for.
      expect(await proc.$reflection["inspect.find"]("parent:first:kid")).toBe(firstAnswer);
      expect(firstAsked).toEqual(["parent:first:kid"]);
      expect(secondAsked).toEqual(["parent:first:kid"]);
      // One process cannot be under two children, so an answer that is not the one handed
      // back is a reference the search obtained and must not leave open.
      expect(letGoOf).toEqual(["parent:second:kid"]);

      await proc.stop();
    });

    it("searches where a child that announces nothing keeps its own children", async () => {
      const Deep = defineActor({ name: "deep", plugins: [], handlers: {} });
      const Plain = defineActor({
        name: "plain",
        plugins: [], // block inheritance: nothing to ask here
        async setup(this: any) {
          await this.fork(Deep);
          return {};
        },
        handlers: {},
      });
      const Parent = defineActor({
        name: "parent",
        plugins: [inspect()],
        async setup(this: any) {
          await this.fork(Plain);
          return {};
        },
        handlers: {},
      });

      const proc = await Parent.spawn({});
      await proc.ready();

      // A child with no methods is still an object of this side's tree, so what it holds
      // is here to be looked at.
      const found = await proc.$reflection["inspect.find"]("parent:plain:deep");
      expect(found).not.toBeNull();
      expect(found!.pname).toBe("parent:plain:deep");

      await proc.stop();
    });
  });
});
