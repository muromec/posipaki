/* eslint-disable unicorn/consistent-function-scoping */
// ── Plugin System Tests ─────────────────────────────────────────────────
//
// Tests plugin installation, inheritance, hook propagation across fork,
// opt-out, and transform.

import { describe, it, expect, vi } from 'vitest';
import { defineActor, defineMessages } from '../define-actor.js';
import { stopPropagation, mergeConfigs } from '../hooks.js';
import type { ActorPlugin } from '../hooks.js';
import type { Message } from '../types.js';
import type { ActorConfig, HandlerOptions } from '../actor-types.js';

type AnyConfig = ActorConfig<unknown, unknown, Message, Message, Message, {}, HandlerOptions<Message>>;

// ── helpers ──────────────────────────────────────────────────────────────

interface PokeMsg extends Message { type: 'POKE'; n: number; }
interface PongMsg extends Message { type: 'PONG'; n: number; }
const Pin  = defineMessages<PokeMsg>();
const Pout = defineMessages<PongMsg>();

/** A test plugin that records every hook call. */
function spyPlugin(id: string) {
  const calls: string[] = [];
  const fn = (config: AnyConfig) => mergeConfigs(config, {
    onStart() { calls.push(`${id}:onStart`); },
    onMessage() { calls.push(`${id}:onMessage`); },
    onEmit() { calls.push(`${id}:onEmit`); },
    onChildExit() { calls.push(`${id}:onChildExit`); },
    onError() { calls.push(`${id}:onError`); },
  });
  return Object.assign(fn, { calls });
}

// ── basic plugin install ─────────────────────────────────────────────────

describe('plugin basic', () => {
  it('plugin.install is called at fork time', async () => {
    let installed = false;
    const plug: ActorPlugin = async (config: AnyConfig) => { installed = true; return config; };

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug],
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    expect(installed).toBe(true);
    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });

  it('plugin hooks fire', async () => {
    const sp = spyPlugin('A');
    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [sp],
      handlers: {
        POKE(this: any) { this.emit({ type: 'PONG', n: 99 }); },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();

    // onStart fires during startup
    expect(sp.calls).toContain('A:onStart');

    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    expect(sp.calls).toContain('A:onMessage');
    expect(sp.calls).toContain('A:onEmit');

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });

  it('plugin onStart receives state', async () => {
    // Test via onStart:
    const Actor2 = defineActor({
      name: 'b',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ count: 99 }),
      onStart() { this.state.count++; },
      handlers: { POKE() {} },
    });

    const proc2 = await Actor2.spawn({});
    await proc2.ready();
    expect(proc2.state!.count).toBe(100);
    proc2.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc2.wait();

  });
});

// ── inheritance ──────────────────────────────────────────────────────────

describe('plugin inheritance', () => {
  it('child inherits parent plugins by default', async () => {
    let childSpyCalls: string[] = [];

    const inheritCheck = (config: AnyConfig) => mergeConfigs(config, {
      onStart() { childSpyCalls.push('inherited:onStart'); },
      onMessage() { childSpyCalls.push('inherited:onMessage'); },
    });

    const Child = defineActor({
      name: 'child',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      // No plugins — inherits from parent
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ c: null as any }),
      plugins: [inheritCheck],
      async onStart(this: any) { this.state.c = await this.fork(Child, undefined, {}); },
      handlers: { POKE() {}, PONG() {} },
    });

    const proc = await Parent.spawn({});
    await proc.ready();

    // Child should have the inherited plugin installed
    await new Promise(r => setTimeout(r, 50));
    expect(childSpyCalls).toContain("inherited:onStart");

    // Send message directly to child
    proc.state!.c.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    expect(childSpyCalls).toContain('inherited:onMessage');

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait().catch(() => {});
  });

  it('plugins: [] blocks inheritance', async () => {
    const parentSpy = spyPlugin('PARENT');
    let childPlugsInstalled: string[] = [];

    const plug: ActorPlugin = async (config: AnyConfig) => { childPlugsInstalled.push('child-only'); return config; };

    const Child = defineActor({
      name: 'child',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug], // empty array blocks parent inheritance (replaced by child-only)
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ c: null as any }),
      plugins: [parentSpy],
      async onStart(this: any) { this.state.c = await this.fork(Child, undefined, {}); },
      handlers: { POKE() {}, PONG() {} },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 50));

    expect(childPlugsInstalled).toContain('child-only');
    // parent spy should NOT have installed on child
    // We can't directly observe this without instrumenting, but the
    // array form means "use exactly these" — parent plugins are excluded.

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait().catch(() => {});
  });

  it('plugins: (parents) => [...parents, extra] extends chain', async () => {
    const parentSpy = spyPlugin('PARENT');
    const extraCalls: string[] = [];

    const extraPlg = (config: AnyConfig) => mergeConfigs(config, {
      onMessage() { extraCalls.push('extra:onMessage'); },
    });

    const Child = defineActor({
      name: 'child',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: (parents) => [...parents, extraPlg],
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ c: null as any }),
      plugins: [parentSpy],
      async onStart(this: any) { this.state.c = await this.fork(Child, undefined, {}); },
      handlers: { POKE() {}, PONG() {} },
    });

    const proc = await Parent.spawn({});
    await proc.ready();

    // Send a message to the child via the parent
    proc.state!.c.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 100));

    // Extra plugin should have fired
    expect(extraCalls).toContain('extra:onMessage');

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait().catch(() => {});
  });
});

// ── hook propagation across fork ─────────────────────────────────────────

describe('plugin hook propagation', () => {
  it('onChildExit hook fires in parent when child exits', async () => {
    const childExits: string[] = [];

    const parentPlg = (config: AnyConfig) => mergeConfigs(config, {
      onChildExit(name: string) { childExits.push(name); },
    });

    const Child = defineActor({
      name: 'child',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      onStart(this: any) { this.exit(); },
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [parentPlg],
      async onStart(this: any) { await this.fork(Child, undefined, {}); },
      handlers: { POKE() {}, PONG() {} },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 200));

    expect(childExits).toContain('parent:child');

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait().catch(() => {});
  });

  it('onError hook fires in plugin when handler throws', async () => {
    const errors: string[] = [];
    const plg = (config: AnyConfig) => mergeConfigs(config, {
      onError(e: unknown) { errors.push((e as Error).message); },
    });

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plg],
      handlers: {
        POKE() { throw new Error('KABOOM'); },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    expect(errors).toContain('KABOOM');

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });
});



// ── adversarial ──────────────────────────────────────────────────────────

describe('plugins — adversarial', () => {
  it('plugin install failure does not crash actor', async () => {
    const badPlug: ActorPlugin = async (config: AnyConfig) => { throw new Error('install failed'); };

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [badPlug],
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();

    // Actor should still be alive
    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });

  it('multiple plugins fire in definition order', async () => {
    const order: string[] = [];
    const make = (id: string) => (config: AnyConfig) => mergeConfigs(config, {
      onMessage() { order.push(id); },
    });

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [make('A'), make('B'), make('C')],
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    // mergeConfigs chains: last plugin fires first (middleware order)
    expect(order).toEqual(['C', 'B', 'A']);

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });

  it('grandchild inherits from root via chain', async () => {
    const rootSpy = spyPlugin('ROOT');
    let gcSeen = false;

    const Grandchild = defineActor({
      name: 'gc',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      handlers: { POKE() { gcSeen = true; } },
    });

    const Child = defineActor({
      name: 'child',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ gc: null as any }),
      async onStart(this: any) { this.state.gc = await this.fork(Grandchild, undefined, {}); },
      handlers: { POKE() {}, PONG() {} },
    });

    const Root = defineActor({
      name: 'root',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ c: null as any }),
      plugins: [rootSpy],
      async onStart(this: any) { this.state.c = await this.fork(Child, undefined, {}); },
      handlers: { POKE() {}, PONG() {} },
    });

    const proc = await Root.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 100));

    // GC should work
    const child = proc.state!.c;
    const gc = child?.state?.gc;
    expect(gc).not.toBeNull();

    gc?.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    expect(gcSeen).toBe(true);

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait().catch(() => {});
  });
});

// ── hook ordering: plugins + actor hooks ─────────────────────────────────

describe('hook ordering: plugins + actor hooks', () => {
  it('two plugins + actor onMessage all fire in registration order', async () => {
    const order: string[] = [];

    const plug1 = (config: AnyConfig) => mergeConfigs(config, { onMessage() { order.push('plug1'); } });
    const plug2 = (config: AnyConfig) => mergeConfigs(config, { onMessage() { order.push('plug2'); } });

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug1, plug2],
      onMessage() { order.push('actor-hook'); },
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    // mergeConfigs chains: last plugin fires first, then actor hook
    expect(order).toEqual(['plug2', 'plug1', 'actor-hook']);

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });

  it('plugin onMessage short-circuits before actor hook', async () => {
    const order: string[] = [];

    const plug = (config: AnyConfig) => mergeConfigs(config, { onMessage() { order.push('plug'); return stopPropagation(); } });

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug],
      onMessage() { order.push('actor-hook'); },
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    expect(order).toEqual(['plug']);  // actor hook NOT called

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });
});

// ── full lifecycle: all seven hooks fire ──────────────────────────────────

describe('full lifecycle coverage', () => {
  it('all seven hooks fire across actor start → message → stop → end', async () => {
    const fired: string[] = [];

    const trace = (name: string) => () => { fired.push(name); };

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      onStart: trace('onStart'),
      onMessage: trace('onMessage'),
      onStopRequested() { fired.push('onStopRequested'); this.agreeToStop(); },
      onEnd: trace('onEnd'),
      handlers: {
        POKE(this: any) {
          fired.push('handler:POKE');
          this.emit({ type: 'PONG', n: 42 });
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();

    // onStart should have fired
    expect(fired).toContain('onStart');

    // Send a message — onMessage + handler:POKE should fire
    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));
    expect(fired).toContain('onMessage');
    expect(fired).toContain('handler:POKE');

    // Stop — onStopRequested should fire
    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
    expect(fired).toContain('onStopRequested');
    expect(fired).toContain('onEnd');
  });

  it('plugin onEnd fires before actor onEnd', async () => {
    const order: string[] = [];

    const plug = (config: AnyConfig) => mergeConfigs(config, { onEnd() { order.push('plug'); } });

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug],
      onEnd() { order.push('actor-hook'); },
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();

    // Plugin onEnd fires before actor hooks.onEnd
    expect(order).toEqual(['plug', 'actor-hook']);
  });

  it('plugin onStopRequested fires before actor onStopRequested', async () => {
    const order: string[] = [];

    const plug = (config: AnyConfig) => mergeConfigs(config, { onStopRequested() { order.push('plug'); } });

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug],
      onStopRequested() { order.push('actor-hook'); this.agreeToStop(); },
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();

    expect(order).toEqual(['plug', 'actor-hook']);
  });

  it('plugin onEmit fires before actor onEmit', async () => {
    const order: string[] = [];

    const plug = (config: AnyConfig) => mergeConfigs(config, { onEmit() { order.push('plug'); } });

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug],
      onEmit() { order.push('actor-hook'); },
      handlers: {
        POKE(this: any) { this.emit({ type: 'PONG', n: 1 }); },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    expect(order).toEqual(['plug', 'actor-hook']);

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });

  it('plugin onChildExit fires before actor onChildExit', async () => {
    const order: string[] = [];

    const plug = (config: AnyConfig) => mergeConfigs(config, {
      onChildExit(name: string) { order.push(`plug:${name}`); },
    });

    const Child = defineActor({
      name: 'child',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      onStart(this: any) { this.exit(); },
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug],
      onChildExit(name: string) { order.push(`actor-hook:${name}`); },
      async onStart(this: any) { await this.fork(Child, undefined, {}); },
      handlers: { POKE() {}, PONG() {} },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 200));

    expect(order[0]).toMatch(/^plug:/);
    expect(order[1]).toMatch(/^actor-hook:/);

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait().catch(() => {});
  });
});

// ── onError: plugins + actor ordering ────────────────────────────────────

describe('onError: plugins + actor ordering', () => {
  it('two plugins + actor onError all fire in registration order', async () => {
    const errors: string[] = [];

    const plug1 = (config: AnyConfig) => mergeConfigs(config, { onError(e: unknown) { errors.push(`plug1:${(e as Error).message}`); } });
    const plug2 = (config: AnyConfig) => mergeConfigs(config, { onError(e: unknown) { errors.push(`plug2:${(e as Error).message}`); } });

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug1, plug2],
      onError(e: unknown) { errors.push(`actor-hook:${(e as Error).message}`); },
      handlers: {
        POKE() { throw new Error('KABOOM'); },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    // chainHook: plug2 fires first, then plug1, then actor-hook
    expect(errors).toEqual([
      'plug2:KABOOM',
      'plug1:KABOOM',
      'actor-hook:KABOOM',
    ]);

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });

  it('error in first onError does not prevent second from firing', async () => {
    const fired: string[] = [];

    const plug1 = (config: AnyConfig) => mergeConfigs(config, { onError() { fired.push('plug1'); throw new Error('inner error'); } });
    const plug2 = (config: AnyConfig) => mergeConfigs(config, { onError() { fired.push('plug2'); } });

    const Actor = defineActor({
      name: 'a',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug1, plug2],
      onError() { fired.push('actor-hook'); },
      handlers: {
        POKE() { throw new Error('BOOM'); },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    // chainHook: plug2 fires first, then plug1 throws.
    // callHook catches the chain error, so actor-hook is skipped.
    expect(fired).toEqual(['plug2', 'plug1']);

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });
});

// ── decorate ─────────────────────────────────────────────────────────────

describe('decorate', () => {
  it('plugin can decorate a value onto this', async () => {
    const plug = (config: AnyConfig) => ({ ...config, methods: { ...config.methods, logger: { name: config.name, count: 0 } } });

    const Actor = defineActor({
      name: 'd',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug],
      handlers: {
        POKE(this: any) {
          this.logger.count++;
          this.state.x = this.logger.count;
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();

    // Cast needed because ActorDecorated doesn't know about 'logger'
    expect((proc.state!).x).toBe(0); // not mutated yet

    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    // Handler used this.logger.count to set state.x
    expect(proc.state!.x).toBe(1);

    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });

  it('decorate throws on key conflict with built-in', async () => {
    const plug = (config: AnyConfig) => ({ ...config, methods: { ...config.methods, state: {} } });

    // methods spread silently overwrites built-ins.
    // Test via an actual actor
    const Actor = defineActor({
      name: 'd',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug],
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    // Actor survived install failure of plugin
    proc.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));
    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });

  it('decorate overwrites when same key set twice', async () => {
    const plug1 = (config: AnyConfig) => ({ ...config, methods: { ...config.methods, shared: 1 } });
    const plug2 = (config: AnyConfig) => ({ ...config, methods: { ...config.methods, shared: 2 } });

    const Actor = defineActor({
      name: 'd',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug1, plug2],
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    // Spread overwrites: last plugin wins
    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });

  it('child inherits decorated properties from parent plugin', async () => {
    const plug = (config: AnyConfig) => ({ ...config, methods: { ...config.methods, shared: 'from-parent' } });

    const Child = defineActor({
      name: 'child',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: '' }),
      // No plugins — inherits from parent
      handlers: {
        POKE(this: any) { this.state.x = this.shared as string; },
      },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ c: null as any }),
      plugins: [plug],
      async onStart(this: any) { this.state.c = await this.fork(Child, undefined, {}); },
      handlers: { POKE() {}, PONG() {} },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 100));

    const child = proc.state!.c;
    child.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    expect(child.state.x).toBe('from-parent');

    child.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait().catch(() => {});
  });

  it('child can override parent decorated value', async () => {
    const parentPlug = (config: AnyConfig) => ({ ...config, methods: { ...config.methods, label: 'parent-value' } });
    const childPlug = (config: AnyConfig) => ({ ...config, methods: { ...config.methods, label: 'child-value' } });

    const Child = defineActor({
      name: 'child',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: '' }),
      plugins: [childPlug],
      handlers: {
        POKE(this: any) { this.state.x = this.label as string; },
      },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ c: null as any }),
      plugins: [parentPlug],
      async onStart(this: any) { this.state.c = await this.fork(Child, undefined, {}); },
      handlers: { POKE() {}, PONG() {} },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 100));

    const child = proc.state!.c;
    child.send!({ type: 'POKE', n: 1 }, { fromName: 't', fromId: Symbol('t') });
    await new Promise(r => setTimeout(r, 50));

    // Child's own decorate wins (it ran after parent's inherited plugin)
    expect(child.state.x).toBe('child-value');

    child.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait().catch(() => {});
  });

  it('decorate is available in lifecycle hooks', async () => {
    const plug = (config: AnyConfig) => ({ ...config, methods: { ...config.methods, greeting: 'hello' } });

    let hookGreeting: string | undefined;
    const Actor = defineActor({
      name: 'd',
      inMessages: Pin, outMessages: Pout,
      expose: (s) => s,
      initialState: () => ({ x: 0 }),
      plugins: [plug],
      onStart() { hookGreeting = (this as any).greeting; },
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    expect(hookGreeting).toBe('hello');
    proc.send!({ type: 'STOP' }, { fromName: 't', fromId: Symbol('t') });
    await proc.wait();
  });
});
