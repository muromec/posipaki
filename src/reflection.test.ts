import { describe, it, expect } from 'vitest';
import type { ActorPlugin } from "./actor-types.js";
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
