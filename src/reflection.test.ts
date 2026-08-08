import { describe, it, expect } from 'vitest';
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
});
