import { describe, it, expect } from 'vitest';
import type { ActorPlugin } from "./actor-types.js";
import { debugLogger } from "./plugins/debug-logger.js";
import { defineActor } from './define-actor';

describe('actor reflection', () => {
  it('populates $reflection from $reflectionMethods', async () => {
    const actor = defineActor({
      $reflectionMethods: {
        getCount(): number {
          return this.state.count;
        },
      },
      setup() {
        return { count: 42 };
      },
      handlers: {},
    });

    const proc = actor.spawn(undefined!);
    await proc.ready();

    const count: number = await proc.$reflection.getCount();
    expect(count).toBe(42);
  });

  it('exposes pname via this.name', async () => {
    const actor = defineActor({
      $reflectionMethods: {
        getName(): string {
          return this.name;
        },
      },
      setup() {
        return {};
      },
      handlers: {},
    });

    const proc = actor.spawn(undefined!);
    await proc.ready();

    const name: string = await proc.$reflection.getName();
    expect(name).toBe('actor');
  });

  it('exposes child actor names via this.$child', async () => {
    const child = defineActor({
      setup() {
        return {};
      },
      handlers: {},
    });

    const parent = defineActor({
      $reflectionMethods: {
        getChildNames(): string[] {
          return Object.keys(this.$child);
        },
      },
      async setup() {
        this.fork(child, 'worker');
        return {};
      },
      handlers: {},
    });

    const proc = parent.spawn(undefined!);
    await proc.ready();

    const names: string[] = await proc.$reflection.getChildNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/worker/);
  });

  it('plugin registers reflection via self.reflection.register()', async () => {
    const testPlugin: ActorPlugin = {
      name: 'testPlugin',
      install(self) {
        self.reflection.register('getCount', function () {
          return (this.state as Record<string, unknown>).count;
        });
      },
    };

    const actor = defineActor({
      plugins: [testPlugin],
      setup() {
        return { count: 42 };
      },
      handlers: {},
    });

    const proc = actor.spawn(undefined!);
    await proc.ready();

    const count: number = await (proc.$reflection as Record<string, Function>)['testPlugin.getCount']();
    expect(count).toBe(42);
  });


  it('plugin reflection works with async setup and multiple plugins', async () => {
    const testPlugin: ActorPlugin = {
      name: 'testPlugin',
      install(self) {
        self.reflection.register('getCount', function () {
          return (this.state as Record<string, unknown>).count;
        });
      },
    };

    const actor = defineActor({
      name: 'async-test',
      plugins: [debugLogger(), testPlugin],
      async setup() {
        await new Promise((r) => setTimeout(r, 10));
        return { count: 42 };
      },
      handlers: {},
    });

    const proc = actor.spawn(undefined!);
    await proc.ready();

    // debugLogger should have decorated this.log
    expect(typeof (proc.$reflection as Record<string, Function>)['testPlugin.getCount']).toBe('function');
    const count: number = await (proc.$reflection as Record<string, Function>)['testPlugin.getCount']();
    expect(count).toBe(42);
  });




  it('one plugin registers two methods', async () => {
    const plug: ActorPlugin = {
      name: 'plug',
      install(self) {
        self.reflection.register('ping', function () { return 'a'; });
        self.reflection.register('pong', function () { return 'b'; });
      },
    };

    const actor = defineActor({
      plugins: [plug],
      setup() { return {}; },
      handlers: {},
    });

    const proc = actor.spawn(undefined!);
    await proc.ready();

    const refl = proc.$reflection as Record<string, Function>;
    expect(typeof refl['plug.ping']).toBe('function');
    expect(typeof refl['plug.pong']).toBe('function');
  });

  it('two plugins both register reflection', async () => {
    const plugA: ActorPlugin = {
      name: 'plugA',
      install(self) {
        self.reflection.register('ping', function () { return 'a'; });
      },
    };
    const plugB: ActorPlugin = {
      name: 'plugB',
      install(self) {
        self.reflection.register('pong', function () { return 'b'; });
      },
    };

    const actor = defineActor({
      plugins: [plugA, plugB],
      setup() { return {}; },
      handlers: {},
    });

    const proc = actor.spawn(undefined!);
    await proc.ready();

    const refl = proc.$reflection as Record<string, Function>;
    expect(typeof refl['plugA.ping']).toBe('function');
    expect(typeof refl['plugB.pong']).toBe('function');
  });

  it('two plugins: debugLogger + testPlugin, sync setup', async () => {
    const testPlugin: ActorPlugin = {
      name: 'testPlugin',
      install(self) {
        self.reflection.register('ping', function () { return 'pong'; });
      },
    };

    const actor = defineActor({
      name: 'two-plugins',
      plugins: [debugLogger(), testPlugin],
      setup() {
        return { count: 0 };
      },
      handlers: {},
    });

    const proc = actor.spawn(undefined!);
    await proc.ready();

    const refl = proc.$reflection as Record<string, Function>;
    expect(typeof refl['testPlugin.ping']).toBe('function');
    expect(await refl['testPlugin.ping']()).toBe('pong');
  });

  it('plugin-registered reflection does not clobber across spawns', async () => {
    const testPlugin: ActorPlugin = {
      name: 'testPlugin',
      install(self) {
        self.reflection.register('getCount', function () {
          return (this.state as Record<string, unknown>).count;
        });
      },
    };

    const actor = defineActor({
      plugins: [testPlugin],
      setup(args: { count: number }) {
        return { count: args.count };
      },
      handlers: {},
    });

    const proc1 = actor.spawn({ count: 10 });
    const proc2 = actor.spawn({ count: 20 });
    await proc1.ready();
    await proc2.ready();

    const c1: number = await (proc1.$reflection as Record<string, Function>)['testPlugin.getCount']();
    const c2: number = await (proc2.$reflection as Record<string, Function>)['testPlugin.getCount']();
    expect(c1).toBe(10);
    expect(c2).toBe(20);
  });

});
