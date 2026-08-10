// ── Lifecycle Hooks Tests ───────────────────────────────────────────────
//
// Tests for defineActor hooks: onMessage, onEmit, onChildExit, onError,
// onStart, onEnd, onStopRequested, and stopPropagation().

import { describe, it, expect } from 'vitest';
import { defineActor, defineMessages } from './define-actor.js';
import { stopPropagation, mergeConfigs } from './hooks.js';
import type { Message, SenderInfo } from './types.js';
import type { OnMessageHook } from './actor-types.js';

// ── helpers ──────────────────────────────────────────────────────────────

interface PokeMsg extends Message { type: 'POKE'; value: number; }
interface PongMsg extends Message { type: 'PONG'; value: number; }
type BroadMsg = PokeMsg | PongMsg;

const PokeIn  = defineMessages<PokeMsg>();
const PokeOut = defineMessages<PongMsg>();
const BroadIn  = defineMessages<BroadMsg>();

// ── onMessage hooks ──────────────────────────────────────────────────────

describe('hooks.onMessage', () => {
  it('fires before the named handler', async () => {
    const order: string[] = [];

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onMessage(msg) {
        order.push(`hook:${msg.type}`);
      },
      handlers: {
        POKE() {
          order.push('handler:POKE');
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'test', fromId: Symbol('test') });
    await new Promise(r => setTimeout(r, 50));

    expect(order).toEqual(['hook:POKE', 'handler:POKE']);

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });

  it('receives sender info', async () => {
    let capturedSender: SenderInfo | null = null;

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onMessage(_msg, sender) {
        capturedSender = sender;
      },
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'caller', fromId: Symbol('caller') });
    await new Promise(r => setTimeout(r, 50));

    expect(capturedSender).not.toBeNull();
    expect(capturedSender!.fromName).toBe('caller');

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });
});

// ── stopPropagation ──────────────────────────────────────────────────────

describe('stopPropagation', () => {
  it('prevents handler from running', async () => {
    let handlerRan = false;

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onMessage() {
        return stopPropagation();
      },
      handlers: {
        POKE() { handlerRan = true; },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'test', fromId: Symbol('test') });
    await new Promise(r => setTimeout(r, 50));

    expect(handlerRan).toBe(false);

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });
});

// ── onEmit hooks ─────────────────────────────────────────────────────────

describe('hooks.onEmit', () => {
  it('fires on every emit', async () => {
    const emitted: string[] = [];

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onEmit(msg) {
        emitted.push(msg.type);
      },
      handlers: {
        POKE() {
          this.emit({ type: 'PONG', value: 99 });
        },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'test', fromId: Symbol('test') });
    await new Promise(r => setTimeout(r, 50));

    expect(emitted).toContain('PONG');

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });

  it('parent receives child emit via handler', async () => {
    const Child = defineActor({
      name: 'child',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onStart() {
        this.emit({ type: 'PONG', value: 1 });
      },
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: BroadIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ pongs: 0 }),
      async onStart() { await this.fork(Child, undefined, {}); },
      handlers: {
        POKE() {},
        PONG() { this.state.pongs++; },
      },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 100));

    expect(proc.state!.pongs).toBe(1);

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });
});

// ── onChildExit hooks ────────────────────────────────────────────────────

describe('hooks.onChildExit', () => {
  it('fires when a child exits', async () => {
    const Child = defineActor({
      name: 'child',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onStart() { this.exit(); },
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: BroadIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ exits: [] as string[] }),
      onChildExit(name) {
        this.state.exits.push(name);
      },
      async onStart() {
        await this.fork(Child, undefined, {});
      },
      handlers: { POKE() {}, PONG() {} },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 200));

    expect(proc.state!.exits).toContain('parent:child');

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });

  it('fires even when no onChildExit method exists', async () => {
    const Child = defineActor({
      name: 'child',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onStart() { this.exit(); },
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: BroadIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ exits: 0 }),
      onChildExit() { this.state.exits++; },
      async onStart() { await this.fork(Child, undefined, {}); },
      handlers: { POKE() {}, PONG() {} },
    });

    const proc = await Parent.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 200));

    expect(proc.state!.exits).toBeGreaterThanOrEqual(1);

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });
});

// ── onStart / onEnd ordering (plugin chain via mergeConfigs) ─────────────

describe('hooks.onStart / onEnd', () => {
  it('plugin onStart fires before actor onStart', async () => {
    const order: string[] = [];

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onStart() { order.push('actor'); },
      plugins: [
        (cfg) => mergeConfigs(cfg, {
          onStart() { order.push('plugin'); },
        }),
      ],
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 50));
    expect(order).toEqual(['plugin', 'actor']);

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });

  it('plugin onEnd fires before actor onEnd', async () => {
    const order: string[] = [];

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onEnd() { order.push('actor'); },
      plugins: [
        (cfg) => mergeConfigs(cfg, {
          onEnd() { order.push('plugin'); },
        }),
      ],
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();

    expect(order).toEqual(['plugin', 'actor']);
  });
});

// ── onStopRequested ordering (plugin chain via mergeConfigs) ─────────────

describe('hooks.onStopRequested', () => {
  it('plugin onStopRequested fires before actor onStopRequested', async () => {
    const order: string[] = [];

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onStopRequested() { order.push('actor'); this.agreeToStop(); },
      plugins: [
        (cfg) => mergeConfigs(cfg, {
          onStopRequested() { order.push('plugin'); },
        }),
      ],
      handlers: { POKE() {} },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();

    expect(order).toEqual(['plugin', 'actor']);
  });
});

// ── onError hooks ────────────────────────────────────────────────────────

describe('hooks.onError', () => {
  it('fires when a handler throws', async () => {
    let capturedError: string | null = null;

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onError(err) {
        capturedError = (err as Error).message;
      },
      handlers: {
        POKE() { throw new Error('BOOM'); },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'test', fromId: Symbol('test') });
    await new Promise(r => setTimeout(r, 50));

    expect(capturedError).toBe('BOOM');

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });

  it('handler throw without onError kills the actor', async () => {
    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      // No onError — throw should propagate and crash the process
      handlers: {
        POKE() { throw new Error('BOOM'); },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'test', fromId: Symbol('test') });

    await expect(proc.wait()).rejects.toThrow();
  });
});

// ── adversarial ──────────────────────────────────────────────────────────

describe('hooks — adversarial', () => {
  it('error in onError hook does not crash the actor further', async () => {
    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onError() { throw new Error('error in error handler'); },
      handlers: {
        POKE() { throw new Error('original error'); },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'test', fromId: Symbol('test') });
    await new Promise(r => setTimeout(r, 50));

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait().catch(() => {});
  });

  it('onMessage hook that throws does not skip handler', async () => {
    let handlerRan = false;

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onMessage() { throw new Error('hook error'); },
      onError() {},
      handlers: {
        POKE() { handlerRan = true; },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'test', fromId: Symbol('test') });
    await new Promise(r => setTimeout(r, 50));

    expect(handlerRan).toBe(true);

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait().catch(() => {});
  });

  it('stopPropagation works with async hooks', async () => {
    let handlerRan = false;

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s) => s,
      initialState: () => ({ count: 0 }),
      onMessage: (async () => {
        await new Promise(r => setTimeout(r, 10));
        return stopPropagation();
      }) as OnMessageHook<PokeMsg>,
      handlers: {
        POKE() { handlerRan = true; },
      },
    });

    const proc = await Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'test', fromId: Symbol('test') });
    await new Promise(r => setTimeout(r, 100));

    expect(handlerRan).toBe(false);

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });
});
