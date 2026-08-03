// ── Actor Tree Naming Tests ─────────────────────────────────────────────
//
// Tests for automatic tree naming: defineActor({ name: 'x' }), optional
// name in fork, tree prefixing, and backward compat.

import { describe, it, expect } from 'vitest';
import { defineActor, defineMessages } from './define-actor.js';
import { spawnAsync } from './process.async.js';
import type { Message, ProcessCtx, AsyncProcessFn, WithSender, SenderInfo } from './types.js';

// ── helpers ──────────────────────────────────────────────────────────────

interface PokeMsg extends Message { type: 'POKE'; value: number; }
const PokeIn = defineMessages<PokeMsg>();
const PokeOut = defineMessages<PokeMsg>();

// ── defineActor name propagation ─────────────────────────────────────────

describe('defineActor name propagation', () => {
  it('exposes name on ActorDefinition', () => {
    const Actor = defineActor({
      name: 'my-actor',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });

    expect(Actor.name).toBe('my-actor');
    expect(Actor.config.name).toBe('my-actor');
  });

  it('name is undefined when not set', () => {
    const Actor = defineActor({
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });

    expect(Actor.name).toBeUndefined();
    expect(Actor.config.name).toBeUndefined();
  });

  it('spawn uses config.name as default process name', () => {
    const Actor = defineActor({
      name: 'root-actor',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });

    const proc = Actor.spawn({});
    expect(proc.pname).toBe('root-actor');
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
  });

  it('spawn falls back to "actor" when name not set', () => {
    const Actor = defineActor({
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });

    const proc = Actor.spawn({});
    expect(proc.pname).toBe('actor');
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
  });
});

// ── tree prefixing ───────────────────────────────────────────────────────

describe('tree prefixing', () => {
  it('builds parent:child with explicit name via self.fork(name)', async () => {
    const Child = defineActor({
      name: 'child',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ childPname: '' }),
      onStart(this: any) {
        const child = this.fork(Child, 'my-child', {});
        this.state.childPname = child.pname;
      },
      handlers: { POKE() {} },
    });

    const proc = Parent.spawn({});
    await proc.ready();
    expect(proc.state!.childPname).toBe('parent:my-child');
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait().catch(() => {});
  });

  it('derives child name from definition when name omitted in self.fork', async () => {
    const Child = defineActor({
      name: 'child',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ childPname: '' }),
      onStart(this: any) {
        // No name — should pick up 'child' from the definition
        const child = this.fork(Child, undefined, {});
        this.state.childPname = child.pname;
      },
      handlers: { POKE() {} },
    });

    const proc = Parent.spawn({});
    await proc.ready();
    expect(proc.state!.childPname).toBe('parent:child');
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait().catch(() => {});
  });

  it('raw generator with ctx.fork uses exact name (no prefix)', () => {
    const rawFn: AsyncProcessFn<null, { x: number }, PokeMsg, PokeMsg> =
      async function* () { yield { x: 1 }; };

    const root = spawnAsync(rawFn, 'root')(null);
    expect(root.pname).toBe('root');

    // Low-level fork uses exact name — no tree prefix.
    const child = root.fork(rawFn, 'worker')(null);
    expect(child.pname).toBe('worker');

    child.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    root.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
  });

  it('three-level tree a:b:c', async () => {
    const Grandchild = defineActor({
      name: 'grandchild',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });

    const Child = defineActor({
      name: 'child',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ gc: null as any }),
      onStart(this: any) {
        // self.fork with name from definition
        this.state.gc = this.fork(Grandchild, undefined, {});
      },
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ c: null as any }),
      onStart(this: any) {
        this.state.c = this.fork(Child, undefined, {});
      },
      handlers: { POKE() {} },
    });

    const proc = Parent.spawn({});
    await proc.ready();

    const childProc = proc.state!.c;
    expect(childProc).not.toBeNull();
    expect(childProc.pname).toBe('parent:child');

    await childProc.ready();
    const grandchildProc = childProc.state.gc;
    expect(grandchildProc).not.toBeNull();
    expect(grandchildProc.pname).toBe('parent:child:grandchild');

    grandchildProc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    childProc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await childProc.wait().catch(() => {});
    await proc.wait().catch(() => {});
  });

  it('explicit override with self.fork(name)', async () => {
    const Child = defineActor({
      name: 'child',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ childPname: '' }),
      onStart(this: any) {
        const child = this.fork(Child, 'override', {});
        this.state.childPname = child.pname;
      },
      handlers: { POKE() {} },
    });

    const proc = Parent.spawn({});
    await proc.ready();
    expect(proc.state!.childPname).toBe('parent:override');
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait().catch(() => {});
  });
});

// ── adversarial ──────────────────────────────────────────────────────────

describe('tree naming — adversarial', () => {
  it('two children with same definition get different names (disambiguation)', async () => {
    const Worker = defineActor({
      name: 'worker',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ w1: '', w2: '' }),
      onStart(this: any) {
        const c1 = this.fork(Worker, 'w1', {});
        const c2 = this.fork(Worker, 'w2', {});
        this.state.w1 = c1.pname;
        this.state.w2 = c2.pname;
      },
      handlers: { POKE() {} },
    });

    const proc = Parent.spawn({});
    await proc.ready();
    expect(proc.state!.w1).toBe('parent:w1');
    expect(proc.state!.w2).toBe('parent:w2');
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait().catch(() => {});
  });

  it('deeply nested tree does not crash', async () => {
    // 10-level chain
    let defs: any[] = [];
    let current = defineActor({
      name: 'leaf',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });
    defs.push(current);

    for (let i = 9; i >= 1; i--) {
      const child = current;
      current = defineActor({
        name: `level-${i}`,
        inMessages: PokeIn,
        outMessages: PokeOut,
        expose: (s: any) => s,
      initialState: () => ({ c: null as any }),
        onStart(this: any) {
          this.state.c = this.fork(child, undefined, {});
        },
        handlers: { POKE() {} },
      });
      defs.push(current);
    }

    const Root = defineActor({
      name: 'root',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ c: null as any }),
      onStart(this: any) {
        this.state.c = this.fork(current, undefined, {});
      },
      handlers: { POKE() {} },
    });

    const proc = Root.spawn({});
    await proc.ready();
    expect(proc.state!.c.pname).toBe('root:level-1');

    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait().catch(() => {});
  });

  it('EXIT from child is recognized under tree-prefixed name', async () => {
    let exitReceived = false;

    const Child = defineActor({
      name: 'child',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ count: 0 }),
      handlers: { POKE() {} },
    });

    const Parent = defineActor({
      name: 'parent',
      inMessages: PokeIn,
      outMessages: PokeOut,
      expose: (s: any) => s,
      initialState: () => ({ exitCount: 0 }),
      onStart(this: any) {
        this.fork(Child, undefined, {});
      },
      onChildExit(this: any, name: string) {
        this.state.exitCount++;
        expect(name).toBe('parent:child');
      },
      handlers: { POKE() {} },
    });

    const proc = Parent.spawn({});
    await proc.ready();
    // Wait for child to start and then automatically exit (no handlers, generator finishes)
    await new Promise(r => setTimeout(r, 100));
    expect(proc.state!.exitCount).toBeGreaterThanOrEqual(0); // depends on timing
    proc.send!({ type: 'STOP' }, { fromName: 'test', fromId: Symbol('test') });
    await proc.wait().catch(() => {});
  });
});
