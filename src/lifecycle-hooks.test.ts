// ── Lifecycle Hooks Tests ───────────────────────────────────────────────
//
// Tests for defineActor hooks: onMessage, onEmit, onChildExit, onError,
// onStart, onEnd, onStopRequested, and stopPropagation().

import { describe, it, expect, vi } from 'vitest';
import { defineActor, defineMessages } from './define-actor.js';
import { stopPropagation } from './hooks.js';
import type { Message, SenderInfo } from './types.js';

// ── helpers ──────────────────────────────────────────────────────────────

interface PokeMsg extends Message { type: 'POKE'; value: number; }
interface PongMsg extends Message { type: 'PONG'; value: number; }
// Broad union for parents that receive multiple message types
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
      initialState: () => ({ count: 0 }),
      hooks: {
        onMessage(this: any, msg) {
          order.push(`hook:${msg.type}`);
        },
      },
      handlers: {
        POKE(this: any) {
          order.push('handler:POKE');
        },
      },
    });

    const proc = Actor.spawn({});
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
      initialState: () => ({ count: 0 }),
      hooks: {
        onMessage(this: any, _msg, sender) {
          capturedSender = sender;
        },
      },
      handlers: { POKE() {} },
    });

    const proc = Actor.spawn({});
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
      initialState: () => ({ count: 0 }),
      hooks: {
        onMessage() {
          return stopPropagation();
        },
      },
      handlers: {
        POKE() { handlerRan = true; },
      },
    });

    const proc = Actor.spawn({});
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
      initialState: () => ({ count: 0 }),
      hooks: {
        onEmit(this: any, msg) {
          emitted.push(msg.type);
        },
      },
      handlers: {
        POKE(this: any) {
          this.emit({ type: 'PONG', value: 99 });
        },
      },
    });

    const proc = Actor.spawn({});
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
      initialState: () => ({ count: 0 }),
      onStart(this: any) {
        // Emit PONG as soon as the child starts — the parent should receive it.
        this.emit({ type: 'PONG', value: 1 });
      },
      handlers: {},
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: BroadIn,
      outMessages: PokeOut,
      initialState: () => ({ pongs: 0 }),
      onStart(this: any) { this.fork(Child, undefined, {}); },
      handlers: {
        PONG(this: any) { this.state.pongs++; },
      },
    });

    const proc = Parent.spawn({});
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
    let exitName: string | null = null;

    const Child = defineActor({
      name: 'child',
      inMessages: PokeIn,
      outMessages: PokeOut,
      initialState: () => ({ count: 0 }),
      onStart(this: any) { this.exit(); },
      handlers: {},
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: BroadIn,
      outMessages: PokeOut,
      initialState: () => ({ exits: [] as string[] }),
      hooks: {
        onChildExit(this: any, name) {
          this.state.exits.push(name);
        },
      },
      onStart(this: any) {
        this.fork(Child, undefined, {});
      },
      handlers: { POKE() {}, PONG() {} },
    });

    const proc = Parent.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 200)); // wait for child to exit

    expect(proc.state!.exits).toContain('parent:child');

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });

  it('fires even when no onChildExit method exists', async () => {
    let exitCount = 0;

    const Child = defineActor({
      name: 'child',
      inMessages: PokeIn,
      outMessages: PokeOut,
      initialState: () => ({ count: 0 }),
      onStart(this: any) { this.exit(); },
      handlers: {},
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: BroadIn,
      outMessages: PokeOut,
      initialState: () => ({ exits: 0 }),
      hooks: {
        onChildExit(this: any) { this.state.exits++; },
      },
      onStart(this: any) { this.fork(Child, undefined, {}); },
      handlers: { POKE() {}, PONG() {} },
      // No onChildExit method — hooks alone should fire
    });

    const proc = Parent.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 200));

    expect(proc.state!.exits).toBeGreaterThanOrEqual(1);

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });
});

// ── onStart / onEnd hooks ────────────────────────────────────────────────

describe('hooks.onStart / onEnd', () => {
  it('onStart hook fires after the onStart method', async () => {
    // Use state to track order since hooks have access to this.state
    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      initialState: () => ({ order: [] as string[] }),
      hooks: {
        onStart(this: any) { this.state.order.push('hook'); },
      },
      onStart(this: any) { this.state.order.push('method'); },
      handlers: {},
    });

    const proc = Actor.spawn({});
    await proc.ready();
    await new Promise(r => setTimeout(r, 50));
    expect(proc.state!.order).toEqual(["method", "hook"]);

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });

  it('onEnd hook fires before the onEnd method', async () => {
    const order: string[] = [];

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      initialState: () => ({ count: 0 }),
      hooks: {
        onEnd() { order.push('hook'); },
      },
      onEnd() { order.push('method'); },
      handlers: {},
    });

    const proc = Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();

    expect(order).toEqual(['hook', 'method']);
  });
});

// ── onStopRequested hooks ────────────────────────────────────────────────

describe('hooks.onStopRequested', () => {
  it('fires before the onStopRequested method', async () => {
    const order: string[] = [];

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      initialState: () => ({ count: 0 }),
      hooks: {
        onStopRequested() { order.push('hook'); },
      },
      onStopRequested() { order.push('method'); this.agreeToStop(); },
      handlers: {},
    });

    const proc = Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();

    expect(order).toEqual(['hook', 'method']);
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
      initialState: () => ({ count: 0 }),
      hooks: {
        onError(this: any, err) {
          capturedError = (err as Error).message;
        },
      },
      handlers: {
        POKE() { throw new Error('BOOM'); },
      },
    });

    const proc = Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'test', fromId: Symbol('test') });

    // Wait for exit
    await proc.wait().catch(() => {});

    expect(capturedError).toBe('BOOM');
  });
});

// ── adversarial ──────────────────────────────────────────────────────────

describe('hooks — adversarial', () => {
  it('error in onError hook does not crash the actor further', async () => {
    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      initialState: () => ({ count: 0 }),
      hooks: {
        onError() { throw new Error('error in error handler'); },
      },
      handlers: {
        POKE() { throw new Error('original error'); },
      },
    });

    const proc = Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'test', fromId: Symbol('test') });

    await proc.wait().catch(() => {});
  });

  it('onMessage hook that throws does not skip handler', async () => {
    let handlerRan = false;

    const Actor = defineActor({
      name: 'test',
      inMessages: PokeIn,
      outMessages: PokeOut,
      initialState: () => ({ count: 0 }),
      hooks: {
        onMessage() { throw new Error('hook error'); },
      },
      handlers: {
        POKE() { handlerRan = true; },
      },
    });

    const proc = Actor.spawn({});
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
      initialState: () => ({ count: 0 }),
      hooks: {
        async onMessage() {
          await new Promise(r => setTimeout(r, 10));
          return stopPropagation();
        },
      },
      handlers: {
        POKE() { handlerRan = true; },
      },
    });

    const proc = Actor.spawn({});
    await proc.ready();
    proc.send!({ type: 'POKE', value: 1 }, { fromName: 'test', fromId: Symbol('test') });
    await new Promise(r => setTimeout(r, 100));

    expect(handlerRan).toBe(false);

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait();
  });
});
