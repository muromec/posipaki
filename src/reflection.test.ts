/* eslint-disable unicorn/consistent-function-scoping */
import { describe, it, expect } from "vitest";
import type { ActorPlugin } from "./actor-types";
import { ActorReflection, mergeConfigs } from "./hooks";
import { debugLogger, type Logger } from "./plugins/debug-logger";
import { defineActor } from "./define-actor";

declare module "./hooks" {
  interface ActorReflection {
    "testPlugin.getCount": () => number;
    "testPlugin.getLog": () => Logger;
    "plug.ping": () => string;
    "plug.pong": () => string;
  }
}

type InnerState = { count: number };
const testPlugin: ActorPlugin = async (config) => {
  return mergeConfigs(config, {
    $reflectionMethods: {
      "testPlugin.getCount": function () {
        const s = this.state as InnerState;
        return s.count;
      },
      "testPlugin.getLog": function () {
        // debugLogger should have decorated this.log
        return this.log;
      },
    },
  });
};

const plug: ActorPlugin = async (config) => {
  return mergeConfigs(config, {
    $reflectionMethods: {
      ...config.$reflectionMethods,
      "plug.ping"() {
        return "a";
      },
      "plug.pong"() {
        return "b";
      },
    },
  });
};

describe("actor reflection", () => {
  it("populates $reflection from $reflectionMethods", async () => {
    const actor = defineActor({
      $reflectionMethods: {
        getCount() {
          return this.state.count;
        },
      },
      setup() {
        return { count: 42 };
      },
      handlers: {},
    });

    const proc = await actor.spawn(undefined!);
    await proc.ready();

    const count: number = proc.$reflection.getCount();
    expect(count).toBe(42);
  });

  it("exposes pname via this.name", async () => {
    const actor = defineActor({
      $reflectionMethods: {
        getName() {
          return this.name;
        },
      },
      handlers: {},
    });

    const proc = await actor.spawn(undefined!);
    await proc.ready();

    const name: string = proc.$reflection.getName();
    expect(name).toBe("actor");
  });

  it("exposes child actor names via this.$child", async () => {
    const child = defineActor({
      name: "child",
      handlers: {},
    });

    const parent = defineActor({
      name: "parent",
      $reflectionMethods: {
        getChildNames() {
          return Object.values(this.$child).map((cproc) => cproc.pname);
        },
      },
      async setup() {
        await this.fork(child);
        return {};
      },
      handlers: {},
    });

    const proc = await parent.spawn(undefined!);
    await proc.ready();

    const names: string[] = proc.$reflection.getChildNames();
    expect(names).toEqual(["parent:child"]);
  });

  it("plugin registers reflection via mergeConfigs", async () => {
    const actor = defineActor({
      plugins: [testPlugin],
      setup() {
        return { count: 42 };
      },
      handlers: {},
    });

    const proc = await actor.spawn(undefined!);
    await proc.ready();

    const count: number = proc.$reflection["testPlugin.getCount"]();
    expect(count).toBe(42);
  });

  it("plugin reflection works with async setup and multiple plugins", async () => {
    const actor = defineActor({
      name: "async-test",
      plugins: [debugLogger(), testPlugin],
      async setup() {
        await new Promise((r) => setTimeout(r, 0));
        return { count: 42 };
      },
      handlers: {},
    });

    const proc = await actor.spawn(undefined!);
    await proc.ready();

    const log: Logger = proc.$reflection["testPlugin.getLog"]();
    expect(typeof log.debug).toBe("function");
    const count: number = proc.$reflection["testPlugin.getCount"]();
    expect(count).toBe(42);
  });

  it("one plugin registers two methods", async () => {
    const actor = defineActor({
      plugins: [plug],
      setup() {
        return {};
      },
      handlers: {},
    });

    const proc = await actor.spawn(undefined!);
    await proc.ready();

    const refl = proc.$reflection;
    expect(typeof refl["plug.ping"]).toBe("function");
    expect(typeof refl["plug.pong"]).toBe("function");
    expect(refl["plug.ping"]()).toBe("a");
    expect(refl["plug.pong"]()).toBe("b");
  });

  it("two plugins both register reflection", async () => {
    const actor = defineActor({
      plugins: [plug, testPlugin],
      setup() {
        return {};
      },
      handlers: {},
    });

    const proc = await actor.spawn(undefined!);
    await proc.ready();

    const refl = proc.$reflection;
    expect(typeof refl["plug.ping"]).toBe("function");
    expect(typeof refl["testPlugin.getLog"]).toBe("function");
    expect(refl["plug.ping"]()).toBe("a");
  });

  it("two plugins: debugLogger + testPlugin, sync setup", async () => {
    const actor = defineActor({
      name: "two-plugins",
      plugins: [debugLogger(), testPlugin],
      setup() {
        return { count: 0 };
      },
      handlers: {},
    });

    const proc = await actor.spawn(undefined!);
    await proc.ready();

    const refl = proc.$reflection;
    expect(typeof refl["testPlugin.getCount"]).toBe("function");
    expect(refl["testPlugin.getCount"]()).toBe(0);
  });

  it("plugin-registered reflection does not clobber across spawns", async () => {
    const actor = defineActor({
      plugins: [testPlugin],
      setup(args: { count: number }) {
        return { count: args.count };
      },
      handlers: {},
    });

    const proc1 = await actor.spawn({ count: 10 });
    const proc2 = await actor.spawn({ count: 20 });
    await proc1.ready();
    await proc2.ready();

    const c1: number = proc1.$reflection["testPlugin.getCount"]();
    const c2: number = proc2.$reflection["testPlugin.getCount"]();
    expect(c1).toBe(10);
    expect(c2).toBe(20);
  });
});
